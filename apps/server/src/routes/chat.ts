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
 * GET /api/workspaces/:workspaceId/chat
 * Fetch chat message logs for the workspace
 */
router.get('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const limit = parseInt(req.query.limit as string || '50', 10);
    const cursor = req.query.cursor as string;

    const messages = await prisma.chatMessage.findMany({
      where: { workspaceId },
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
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

    const sorted = [...messages].reverse();
    const nextCursor = messages.length === limit ? messages[messages.length - 1].id : null;

    res.json({
      success: true,
      data: {
        messages: sorted,
        nextCursor
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces/:workspaceId/chat
 * Create new chat message
 */
router.post('/', async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const { message } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required' }
      });
      return;
    }

    if (!message || typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({
        success: false,
        error: { message: 'Message content is required' }
      });
      return;
    }

    const newMessage = await prisma.chatMessage.create({
      data: {
        workspaceId,
        userId,
        message
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
      data: newMessage
    });
  } catch (error) {
    next(error);
  }
});

export default router;
