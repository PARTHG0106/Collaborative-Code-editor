import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { normalizeOrigin, originAllowlist } from '../lib/corsOrigins.js';

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

/**
 * GET /api/health/cors
 *
 * Reports the allowlist this process actually parsed and evaluates an origin
 * against it. A CORS failure in a browser is deliberately vague for security
 * reasons, and an invisible character in CORS_ORIGINS looks identical to a
 * correct value in the startup banner, so there needs to be a way to ask the
 * server what it decided.
 *
 * Pass ?origin=https://example.com to test a specific value, or call it from a
 * browser to have your own Origin header evaluated. Reveals only origins that
 * are already visible to any browser client.
 */
router.get('/cors', (req: Request, res: Response) => {
  const requestOrigin = req.headers.origin ?? null;
  const queryOriginRaw = typeof req.query.origin === 'string' ? req.query.origin : null;

  res.json({
    success: true,
    data: {
      allowlist: {
        entries: originAllowlist.entries,
        exact: originAllowlist.exact,
        wildcard: originAllowlist.wildcard,
        warnings: originAllowlist.warnings,
      },
      requestOrigin: requestOrigin
        ? {
            raw: requestOrigin,
            normalized: normalizeOrigin(requestOrigin),
            allowed: originAllowlist.isAllowed(requestOrigin),
          }
        : null,
      queryOrigin: queryOriginRaw
        ? {
            raw: queryOriginRaw,
            normalized: normalizeOrigin(queryOriginRaw),
            allowed: originAllowlist.isAllowed(queryOriginRaw),
          }
        : null,
      note: 'Requests without an Origin header (server-to-server, health checks, CLI) are always allowed and are not covered by this allowlist.',
    },
  });
});

export default router;
