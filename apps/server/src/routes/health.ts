import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

/**
 * GET /api/health
 * Returns server and database health status.
 */
router.get('/', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Check database connectivity
    await prisma.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - startTime;

    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        version: '0.1.0',
        services: {
          database: {
            status: 'connected',
            latency: `${dbLatency}ms`,
          },
        },
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      data: {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services: {
          database: {
            status: 'disconnected',
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        },
      },
    });
  }
});

/**
 * GET /api/health/ping
 * Simple liveness probe — no database dependency.
 */
router.get('/ping', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      message: 'pong',
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
