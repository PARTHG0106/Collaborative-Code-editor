import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceRole, WorkspaceRequest } from '../middleware/workspace.js';

const router = Router({ mergeParams: true });

// Enforce auth on all file endpoints
router.use(requireAuth);

// Input Validation Schemas
const createFileSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100)
    .refine(val => !val.includes('/') && !val.includes('\\'), 'Name cannot contain path separators'),
  type: z.enum(['FILE', 'FOLDER']),
  parentId: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
});

const updateFileSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100)
    .refine(val => !val.includes('/') && !val.includes('\\'), 'Name cannot contain path separators')
    .optional(),
  content: z.string().optional().nullable(),
});

/**
 * GET /api/workspaces/:workspaceId/files
 * Retrieves flat list of all file system items in the workspace.
 */
router.get(
  '/',
  requireWorkspaceRole(['OWNER', 'EDITOR', 'VIEWER']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId } = req.params;

      const items = await prisma.fileSystemItem.findMany({
        where: { workspaceId },
        orderBy: [
          { type: 'asc' }, // FOLDER first, then FILE
          { name: 'asc' },
        ],
      });

      return res.status(200).json({
        success: true,
        data: items,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/workspaces/:workspaceId/files
 * Create a new file or folder in the workspace.
 */
router.post(
  '/',
  requireWorkspaceRole(['OWNER', 'EDITOR']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId } = req.params;
      const body = createFileSchema.parse(req.body);

      // If parentId is specified, verify it exists and is a FOLDER in the same workspace
      if (body.parentId) {
        const parent = await prisma.fileSystemItem.findUnique({
          where: { id: body.parentId },
        });

        if (!parent || parent.workspaceId !== workspaceId) {
          return res.status(400).json({
            success: false,
            error: { message: 'Parent directory does not exist in this workspace' },
          });
        }

        if (parent.type !== 'FOLDER') {
          return res.status(400).json({
            success: false,
            error: { message: 'Parent item is not a folder' },
          });
        }
      }

      // Check if file/folder with the same name already exists in the same parent directory
      const existing = await prisma.fileSystemItem.findFirst({
        where: {
          workspaceId,
          parentId: body.parentId || null,
          name: { equals: body.name, mode: 'insensitive' }, // Case insensitive check
        },
      });

      if (existing) {
        return res.status(400).json({
          success: false,
          error: { message: `An item named '${body.name}' already exists in this folder` },
        });
      }

      // Create item
      const item = await prisma.fileSystemItem.create({
        data: {
          workspaceId,
          name: body.name,
          type: body.type,
          parentId: body.parentId || null,
          content: body.type === 'FILE' ? (body.content || '') : null,
        },
      });

      return res.status(201).json({
        success: true,
        data: item,
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
 * PATCH /api/workspaces/:workspaceId/files/:id
 * Rename item or update file content.
 */
router.patch(
  '/:id',
  requireWorkspaceRole(['OWNER', 'EDITOR']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, id } = req.params;
      const body = updateFileSchema.parse(req.body);

      // Verify the item exists and belongs to this workspace
      const item = await prisma.fileSystemItem.findUnique({
        where: { id },
      });

      if (!item || item.workspaceId !== workspaceId) {
        return res.status(404).json({
          success: false,
          error: { message: 'File system item not found' },
        });
      }

      // If updating content, ensure it is a FILE
      if (body.content !== undefined && item.type !== 'FILE') {
        return res.status(400).json({
          success: false,
          error: { message: 'Cannot set content on a folder' },
        });
      }

      // If renaming, ensure name is not taken in the same directory
      let newName = item.name;
      if (body.name && body.name.toLowerCase() !== item.name.toLowerCase()) {
        const existing = await prisma.fileSystemItem.findFirst({
          where: {
            workspaceId,
            parentId: item.parentId,
            name: { equals: body.name, mode: 'insensitive' },
            id: { not: id },
          },
        });

        if (existing) {
          return res.status(400).json({
            success: false,
            error: { message: `An item named '${body.name}' already exists in this folder` },
          });
        }
        newName = body.name;
      }

      // Update
      const updated = await prisma.fileSystemItem.update({
        where: { id },
        data: {
          name: newName,
          content: body.content !== undefined ? body.content : item.content,
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
 * DELETE /api/workspaces/:workspaceId/files/:id
 * Delete a file or folder recursively.
 */
router.delete(
  '/:id',
  requireWorkspaceRole(['OWNER', 'EDITOR']),
  async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, id } = req.params;

      // Verify the item exists and belongs to this workspace
      const item = await prisma.fileSystemItem.findUnique({
        where: { id },
      });

      if (!item || item.workspaceId !== workspaceId) {
        return res.status(404).json({
          success: false,
          error: { message: 'File system item not found' },
        });
      }

      // Delete the item (cascades automatically to all children in DB due to onDelete: Cascade)
      await prisma.fileSystemItem.delete({
        where: { id },
      });

      return res.status(200).json({
        success: true,
        data: { message: 'Item deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
