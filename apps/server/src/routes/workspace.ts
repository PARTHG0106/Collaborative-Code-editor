import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceRole, WorkspaceRequest } from '../middleware/workspace.js';

const router = Router();

// Input Validation Schemas
const createWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100),
  description: z.string().max(500).optional().nullable(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100).optional(),
  description: z.string().max(500).optional().nullable(),
});

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(['EDITOR', 'VIEWER']),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(['EDITOR', 'VIEWER']),
});

// Enforce auth on all workspace endpoints
router.use(requireAuth);

/**
 * GET /api/workspaces
 * List all workspaces current user is a member of.
 */
router.get('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;

    const members = await prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
      orderBy: {
        joinedAt: 'desc',
      },
    });

    const workspaces = members.map((m: any) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      description: m.workspace.description,
      role: m.role,
      joinedAt: m.joinedAt,
      memberCount: m.workspace._count.members,
      createdAt: m.workspace.createdAt,
      updatedAt: m.workspace.updatedAt,
    }));

    return res.status(200).json({
      success: true,
      data: workspaces,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces
 * Create a new workspace (creator automatically becomes OWNER).
 */
router.post('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const body = createWorkspaceSchema.parse(req.body);

    // Create workspace and owner membership record in a single transaction
    const workspace = await prisma.$transaction(async (tx: any) => {
      const ws = await tx.workspace.create({
        data: {
          name: body.name,
          description: body.description,
        },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: ws.id,
          userId,
          role: 'OWNER',
        },
      });

      return ws;
    });

    return res.status(201).json({
      success: true,
      data: {
        ...workspace,
        role: 'OWNER',
        memberCount: 1,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          details: error.flatten().fieldErrors,
        },
      });
    }
    next(error);
  }
});

/**
 * GET /api/workspaces/:id
 * Retrieve details of a specific workspace along with its member list.
 */
router.get(
  '/:id',
  requireWorkspaceRole(['OWNER', 'EDITOR', 'VIEWER']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const workspace = await prisma.workspace.findUnique({
        where: { id },
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
            orderBy: {
              role: 'asc', // OWNER first, then EDITOR, then VIEWER
            },
          },
        },
      });

      if (!workspace) {
        return res.status(404).json({
          success: false,
          error: { message: 'Workspace not found' },
        });
      }

      // Format response to flat members array
      const formattedWorkspace = {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        currentUserRole: req.workspaceMember!.role,
        members: workspace.members.map((m: any) => ({
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
      };

      return res.status(200).json({
        success: true,
        data: formattedWorkspace,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/workspaces/:id
 * Update workspace properties. Requires OWNER or EDITOR role.
 */
router.patch(
  '/:id',
  requireWorkspaceRole(['OWNER', 'EDITOR']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = updateWorkspaceSchema.parse(req.body);

      const updated = await prisma.workspace.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
        },
      });

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.flatten().fieldErrors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * DELETE /api/workspaces/:id
 * Delete workspace. Requires OWNER role.
 */
router.delete(
  '/:id',
  requireWorkspaceRole(['OWNER']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await prisma.workspace.delete({
        where: { id },
      });

      return res.status(200).json({
        success: true,
        data: { message: 'Workspace deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/workspaces/:id/members
 * Invite/Add user to workspace by email. Requires OWNER or EDITOR role.
 */
router.post(
  '/:id/members',
  requireWorkspaceRole(['OWNER', 'EDITOR']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = inviteMemberSchema.parse(req.body);

      // Find user to invite
      const invitee = await prisma.user.findUnique({
        where: { email: body.email },
      });

      if (!invitee) {
        return res.status(404).json({
          success: false,
          error: { message: `User with email '${body.email}' not found` },
        });
      }

      // Check if user is already a member
      const existingMember = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: id,
            userId: invitee.id,
          },
        },
      });

      if (existingMember) {
        return res.status(400).json({
          success: false,
          error: { message: 'User is already a member of this workspace' },
        });
      }

      // Create membership record
      const member = await prisma.workspaceMember.create({
        data: {
          workspaceId: id,
          userId: invitee.id,
          role: body.role,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.status(201).json({
        success: true,
        data: {
          userId: member.user.id,
          name: member.user.name,
          email: member.user.email,
          role: member.role,
          joinedAt: member.joinedAt,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.flatten().fieldErrors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * PATCH /api/workspaces/:id/members/:userId
 * Update member permission level. Requires OWNER role.
 */
router.patch(
  '/:id/members/:userId',
  requireWorkspaceRole(['OWNER']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id, userId } = req.params;
      const body = updateMemberRoleSchema.parse(req.body);

      // Ensure they are not trying to change their own role (the OWNER role is protected)
      if (userId === req.user!.id) {
        return res.status(400).json({
          success: false,
          error: { message: 'You cannot change your own workspace permission' },
        });
      }

      // Check if member exists
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: id,
            userId,
          },
        },
      });

      if (!member) {
        return res.status(404).json({
          success: false,
          error: { message: 'Member not found in this workspace' },
        });
      }

      const updated = await prisma.workspaceMember.update({
        where: {
          workspaceId_userId: {
            workspaceId: id,
            userId,
          },
        },
        data: {
          role: body.role,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: {
          userId: updated.user.id,
          name: updated.user.name,
          email: updated.user.email,
          role: updated.role,
          joinedAt: updated.joinedAt,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.flatten().fieldErrors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * DELETE /api/workspaces/:id/members/:userId
 * Remove a member from the workspace. Requires OWNER role OR the member themselves leaving.
 */
router.delete(
  '/:id/members/:userId',
  requireWorkspaceRole(['OWNER', 'EDITOR', 'VIEWER']), // Role check handled customly inside controller
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { id, userId } = req.params;
      const callerUserId = req.user!.id;
      const callerRole = req.workspaceMember!.role;

      // Permission guards:
      // 1. OWNER can remove anyone (except themselves - they must delete the workspace or transfer ownership)
      // 2. Any member can remove themselves (leave workspace)
      // 3. EDITORS/VIEWERS cannot remove other members
      const isSelfRemoval = callerUserId === userId;
      const isOwnerRemoval = callerRole === 'OWNER';

      if (!isSelfRemoval && !isOwnerRemoval) {
        return res.status(403).json({
          success: false,
          error: { message: 'You do not have permission to remove this member' },
        });
      }

      if (isSelfRemoval && callerRole === 'OWNER') {
        return res.status(400).json({
          success: false,
          error: { message: 'Workspace OWNER cannot leave. Please transfer ownership or delete the workspace' },
        });
      }

      // Check if membership exists
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: id,
            userId,
          },
        },
      });

      if (!member) {
        return res.status(404).json({
          success: false,
          error: { message: 'Member not found in this workspace' },
        });
      }

      await prisma.workspaceMember.delete({
        where: {
          workspaceId_userId: {
            workspaceId: id,
            userId,
          },
        },
      });

      return res.status(200).json({
        success: true,
        data: { message: isSelfRemoval ? 'Left workspace successfully' : 'Member removed successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
