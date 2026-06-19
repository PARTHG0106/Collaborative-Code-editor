import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceRole, WorkspaceRequest } from '../middleware/workspace.js';
import { WorkspaceRole } from '@prisma/client';

const router = Router();

// All workspace routes require authentication
router.use(requireAuth);

const createWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100),
  description: z.string().max(500).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

const updateMemberSchema = z.object({
  role: z.nativeEnum(WorkspaceRole),
});

const createInvitationSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum([WorkspaceRole.EDITOR, WorkspaceRole.VIEWER]),
});

/**
 * GET /api/workspaces
 * List all workspaces current user is member of.
 */
router.get('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { members: true },
            },
          },
        },
      },
      orderBy: {
        workspace: {
          name: 'asc',
        },
      },
    });

    const workspaces = memberships.map((m) => ({
      ...m.workspace,
      role: m.role,
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
 * Create a new workspace. Caller becomes OWNER.
 */
router.post('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const body = createWorkspaceSchema.parse(req.body);
    const userId = req.user!.id;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create Workspace
      const workspace = await tx.workspace.create({
        data: {
          name: body.name,
          description: body.description,
        },
      });

      // 2. Add creator as OWNER member
      const member = await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId,
          role: WorkspaceRole.OWNER,
        },
      });

      return { workspace, member };
    });

    return res.status(201).json({
      success: true,
      data: {
        ...result.workspace,
        role: result.member.role,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }
    next(error);
  }
});

/**
 * GET /api/workspaces/:workspaceId
 * Get detailed workspace workspace info including members and pending invites.
 */
router.get(
  '/:workspaceId',
  requireWorkspaceRole([WorkspaceRole.OWNER, WorkspaceRole.EDITOR, WorkspaceRole.VIEWER]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspace!.id;
      const userRole = req.workspaceMember!.role;

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
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
              createdAt: 'asc',
            },
          },
          invitations: {
            where: {
              status: 'PENDING',
              expiresAt: { gt: new Date() },
            },
            include: {
              invitedBy: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: {
              createdAt: 'desc',
            },
          },
        },
      });

      if (!workspace) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Workspace not found',
            statusCode: 404,
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          role: userRole,
          members: workspace.members.map((m) => ({
            id: m.id,
            userId: m.user.id,
            name: m.user.name,
            email: m.user.email,
            role: m.role,
            joinedAt: m.createdAt,
          })),
          invitations: workspace.invitations.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            expiresAt: i.expiresAt,
            createdAt: i.createdAt,
            invitedBy: i.invitedBy,
            token: i.token, // Return token for developer testing ease
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/workspaces/:workspaceId
 * Update workspace info.
 */
router.patch(
  '/:workspaceId',
  requireWorkspaceRole([WorkspaceRole.OWNER]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const body = updateWorkspaceSchema.parse(req.body);
      const workspaceId = req.workspace!.id;

      const updated = await prisma.workspace.update({
        where: { id: workspaceId },
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
            statusCode: 400,
            details: error.errors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * DELETE /api/workspaces/:workspaceId
 * Delete workspace.
 */
router.delete(
  '/:workspaceId',
  requireWorkspaceRole([WorkspaceRole.OWNER]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspace!.id;

      await prisma.workspace.delete({
        where: { id: workspaceId },
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Workspace deleted successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/workspaces/:workspaceId/members/:memberId
 * Update a member's role.
 */
router.patch(
  '/:workspaceId/members/:memberId',
  requireWorkspaceRole([WorkspaceRole.OWNER]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { memberId } = req.params;
      const body = updateMemberSchema.parse(req.body);
      const workspaceId = req.workspace!.id;

      // Check if target member exists in workspace
      const member = await prisma.workspaceMember.findUnique({
        where: { id: memberId },
      });

      if (!member || member.workspaceId !== workspaceId) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Member not found in this workspace',
            statusCode: 404,
          },
        });
      }

      // If user is trying to change their own role and they are the owner, check that there is at least one other owner
      if (member.userId === req.user!.id && member.role === WorkspaceRole.OWNER && body.role !== WorkspaceRole.OWNER) {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId, role: WorkspaceRole.OWNER },
        });

        if (ownerCount <= 1) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Cannot demote the only Owner of the workspace. Transfer ownership first.',
              statusCode: 400,
            },
          });
        }
      }

      const updatedMember = await prisma.workspaceMember.update({
        where: { id: memberId },
        data: { role: body.role },
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
          id: updatedMember.id,
          userId: updatedMember.user.id,
          name: updatedMember.user.name,
          email: updatedMember.user.email,
          role: updatedMember.role,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            statusCode: 400,
            details: error.errors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * DELETE /api/workspaces/:workspaceId/members/:memberId
 * Remove a member from the workspace (or self-leave).
 */
router.delete(
  '/:workspaceId/members/:memberId',
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, memberId } = req.params;
      const userId = req.user!.id;

      // 1. Fetch current user role
      const currentUserMember = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId,
          },
        },
      });

      if (!currentUserMember) {
        return res.status(403).json({
          success: false,
          error: {
            message: 'You are not a member of this workspace',
            statusCode: 403,
          },
        });
      }

      // 2. Fetch target member details
      const targetMember = await prisma.workspaceMember.findUnique({
        where: { id: memberId },
      });

      if (!targetMember || targetMember.workspaceId !== workspaceId) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Member not found in this workspace',
            statusCode: 404,
          },
        });
      }

      // 3. Rule checks:
      // - Only OWNER can remove other members
      // - Anyone can remove themselves (leave workspace)
      const isSelf = targetMember.userId === userId;
      const isOwner = currentUserMember.role === WorkspaceRole.OWNER;

      if (!isSelf && !isOwner) {
        return res.status(403).json({
          success: false,
          error: {
            message: 'Only workspace owners can remove members',
            statusCode: 403,
          },
        });
      }

      // - Cannot remove the last OWNER
      if (targetMember.role === WorkspaceRole.OWNER) {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId, role: WorkspaceRole.OWNER },
        });

        if (ownerCount <= 1) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Cannot remove the last Owner of the workspace.',
              statusCode: 400,
            },
          });
        }
      }

      await prisma.workspaceMember.delete({
        where: { id: memberId },
      });

      return res.status(200).json({
        success: true,
        data: {
          message: isSelf ? 'Left workspace successfully' : 'Member removed successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/workspaces/:workspaceId/invitations
 * Invite a user by email to join the workspace.
 */
router.post(
  '/:workspaceId/invitations',
  requireWorkspaceRole([WorkspaceRole.OWNER, WorkspaceRole.EDITOR]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const body = createInvitationSchema.parse(req.body);
      const workspaceId = req.workspace!.id;
      const invitedById = req.user!.id;

      // Check if user is already a member
      const existingUser = await prisma.user.findUnique({
        where: { email: body.email },
      });

      if (existingUser) {
        const member = await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId,
              userId: existingUser.id,
            },
          },
        });

        if (member) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'User is already a member of this workspace',
              statusCode: 400,
            },
          });
        }
      }

      // Generate verification token and set expiration to 7 days
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      // Create or update pending invitation
      const invitation = await prisma.workspaceInvitation.upsert({
        where: { token },
        create: {
          workspaceId,
          email: body.email,
          role: body.role,
          token,
          invitedById,
          expiresAt,
        },
        update: {
          role: body.role,
          invitedById,
          expiresAt,
          status: 'PENDING',
        },
        include: {
          invitedBy: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return res.status(201).json({
        success: true,
        data: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          token: invitation.token,
          expiresAt: invitation.expiresAt,
          invitedBy: invitation.invitedBy,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            statusCode: 400,
            details: error.errors,
          },
        });
      }
      next(error);
    }
  }
);

/**
 * GET /api/workspaces/invitations/:token
 * Public check of invitation details.
 */
router.get('/invitations/check/:token', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    const invite = await prisma.workspaceInvitation.findUnique({
      where: { token },
      include: {
        workspace: {
          select: {
            name: true,
            description: true,
          },
        },
        invitedBy: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Invitation is invalid, expired, or has already been accepted/rejected',
          statusCode: 400,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        workspaceName: invite.workspace.name,
        workspaceDescription: invite.workspace.description,
        invitedByName: invite.invitedBy.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/invitations/:token/accept
 * Accept workspace invitation.
 */
router.post('/invitations/check/:token/accept', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const userId = req.user!.id;
    const userEmail = req.user!.email;

    const invite = await prisma.workspaceInvitation.findUnique({
      where: { token },
    });

    if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Invitation is invalid, expired, or has already been processed',
          statusCode: 400,
        },
      });
    }

    // Verify invitation email matches current user email
    if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: {
          message: 'This invitation was sent to a different email address',
          statusCode: 403,
        },
      });
    }

    // Accept invitation inside transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Add user as member
      const member = await tx.workspaceMember.create({
        data: {
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role,
        },
        include: {
          workspace: true,
        },
      });

      // 2. Mark invite as accepted
      await tx.workspaceInvitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED' },
      });

      return member;
    });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Workspace invitation accepted successfully',
        workspace: {
          id: result.workspace.id,
          name: result.workspace.name,
          role: result.role,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/invitations/:token/decline
 * Decline workspace invitation.
 */
router.post('/invitations/check/:token/decline', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    const invite = await prisma.workspaceInvitation.findUnique({
      where: { token },
    });

    if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Invitation is invalid or has already been processed',
          statusCode: 400,
        },
      });
    }

    await prisma.workspaceInvitation.update({
      where: { id: invite.id },
      data: { status: 'REJECTED' },
    });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Invitation declined successfully',
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/invitations/:invitationId
 * Cancel/Revoke a pending invitation.
 */
router.delete(
  '/:workspaceId/invitations/:invitationId',
  requireWorkspaceRole([WorkspaceRole.OWNER, WorkspaceRole.EDITOR]),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { invitationId } = req.params;
      const workspaceId = req.workspace!.id;

      const invite = await prisma.workspaceInvitation.findUnique({
        where: { id: invitationId },
      });

      if (!invite || invite.workspaceId !== workspaceId) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Invitation not found in this workspace',
            statusCode: 404,
          },
        });
      }

      await prisma.workspaceInvitation.update({
        where: { id: invitationId },
        data: { status: 'CANCELLED' },
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Invitation cancelled successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
