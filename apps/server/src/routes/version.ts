import { Response, NextFunction } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceRole, WorkspaceRequest } from '../middleware/workspace.js';

const router = Router({ mergeParams: true });

// Protect all routes
router.use(requireAuth);
router.use(requireWorkspaceRole(['OWNER', 'EDITOR', 'VIEWER']));

/**
 * GET /api/workspaces/:workspaceId/files/:fileId/versions
 * Retrieves snapshot list for a file
 */
router.get('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { fileId } = req.params as { fileId: string };

    const versions = await prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    res.json({
      success: true,
      data: versions
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/:workspaceId/files/:fileId/versions
 * Creates a manual checkpoint version snapshot
 */
router.post('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { fileId } = req.params as { fileId: string };
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required' }
      });
      return;
    }

    // Get current file content
    const file = await prisma.fileSystemItem.findUnique({
      where: { id: fileId }
    });

    if (!file || file.type !== 'FILE') {
      res.status(404).json({
        success: false,
        error: { message: 'File not found' }
      });
      return;
    }

    // Determine version index (count + 1)
    const count = await prisma.fileVersion.count({
      where: { fileId }
    });

    const newVersion = await prisma.fileVersion.create({
      data: {
        fileId,
        content: file.content || '',
        version: count + 1,
        userId
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      data: newVersion
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/:workspaceId/files/:fileId/versions/:versionId/restore
 * Restores file content to a version snapshot
 */
router.post('/:versionId/restore', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { fileId, versionId } = req.params as { fileId: string; versionId: string };

    const versionItem = await prisma.fileVersion.findUnique({
      where: { id: versionId }
    });

    if (!versionItem || versionItem.fileId !== fileId) {
      res.status(404).json({
        success: false,
        error: { message: 'Version snapshot not found' }
      });
      return;
    }

    // Update main file content
    const updatedFile = await prisma.fileSystemItem.update({
      where: { id: fileId },
      data: { content: versionItem.content }
    });

    res.json({
      success: true,
      data: updatedFile
    });
  } catch (error) {
    next(error);
  }
});

export default router;
