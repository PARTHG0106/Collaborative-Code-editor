import { Response, NextFunction } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceRole, WorkspaceRequest } from '../middleware/workspace.js';
import { getActiveFileContent, replaceFileContent } from '../socket.js';

const router = Router({ mergeParams: true });

// Protect all routes
router.use(requireAuth);
router.use(requireWorkspaceRole(['OWNER', 'EDITOR', 'VIEWER']));
router.use(async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const file = await prisma.fileSystemItem.findUnique({ where: { id: req.params.fileId } });
    if (!file || file.type !== 'FILE' || file.workspaceId !== req.params.workspaceId) {
      res.status(404).json({ success: false, error: { message: 'File not found' } });
      return;
    }
    next();
  } catch (error) { next(error); }
});

/**
 * GET /api/workspaces/:workspaceId/files/:fileId/versions
 * Retrieves a paginated snapshot list for a file.
 *
 * Each FileVersion stores a full copy of the file's content, and snapshots are
 * created automatically (every 50 edits / 2 minutes) plus on eviction and
 * manual checkpoints, so the list grows without bound. Returning every row with
 * its entire content could be many megabytes. We paginate (cursor) and select
 * only metadata; the full content is loaded lazily on restore.
 */
router.get('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { fileId } = req.params as { fileId: string };

    // Clamp page size so a client cannot request an unbounded page.
    const rawLimit = parseInt((req.query.limit as string) || '50', 10);
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    const versions = await prisma.fileVersion.findMany({
      where: { fileId },
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      // Metadata only: never ship the full content blob in the list payload.
      select: {
        id: true,
        version: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    const nextCursor = versions.length === limit ? versions[versions.length - 1].id : null;

    res.json({
      success: true,
      data: versions,
      nextCursor
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workspaces/:workspaceId/files/:fileId/versions/:versionId
 * Loads a single version including its full content. The list endpoint omits
 * content for payload size, so the client fetches it lazily here when a user
 * previews a specific snapshot.
 */
router.get('/:versionId', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { fileId, versionId } = req.params as { fileId: string; versionId: string };

    const version = await prisma.fileVersion.findUnique({
      where: { id: versionId },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    if (!version || version.fileId !== fileId) {
      res.status(404).json({
        success: false,
        error: { message: 'Version snapshot not found' }
      });
      return;
    }

    res.json({
      success: true,
      data: version
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/:workspaceId/files/:fileId/versions
 * Creates a manual checkpoint version snapshot
 */
router.post('/', requireWorkspaceRole(['OWNER', 'EDITOR']), async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
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
        content: getActiveFileContent(fileId) ?? file.content ?? '',
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
router.post('/:versionId/restore', requireWorkspaceRole(['OWNER', 'EDITOR']), async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
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
    const updatedFile = await replaceFileContent(fileId, req.params.workspaceId, versionItem.content, req.user!.id);

    res.json({
      success: true,
      data: updatedFile
    });
  } catch (error) {
    next(error);
  }
});

export default router;
