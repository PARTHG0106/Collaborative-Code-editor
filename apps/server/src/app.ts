import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { originAllowlist } from './lib/corsOrigins.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspace.js';
import fileRoutes from './routes/file.js';
import chatRoutes from './routes/chat.js';
import versionRoutes from './routes/version.js';

/**
 * Creates and configures the Express application.
 * Separated from server startup for testability.
 */
export function createApp(): express.Application {
  const app = express();

  // Behind the Hugging Face / Vercel proxy, so req.ip must come from
  // X-Forwarded-For. express-rate-limit keys on req.ip, and without this every
  // request would share the proxy's address and one client could exhaust the
  // limit for everyone.
  app.set('trust proxy', 1);

  // ---------------------
  // Security Middleware
  // ---------------------
  app.use(helmet());

  // Explicit allowlist. Reflecting an arbitrary Origin back while sending
  // credentials lets any site issue authenticated requests on behalf of a
  // logged-in user, so the origin is checked against config.corsOrigins.
  // Comparison happens on normalized values because an invisible character or a
  // trailing slash in the configured value is otherwise indistinguishable from
  // a correctly configured server that rejects your own frontend.
  for (const warning of originAllowlist.warnings) {
    console.warn(`\u26a0\ufe0f CORS_ORIGINS: ${warning}`);
  }

  if (originAllowlist.entries.length === 0) {
    console.warn(
      '\u26a0\ufe0f CORS_ORIGINS produced an empty allowlist. Every cross-origin browser request will be refused.',
    );
  }

  // Origins already reported, so one misconfigured client retrying in a loop
  // cannot bury the rest of the log.
  const reportedOrigins = new Set<string>();

  const reportBlockedOrigin = (origin: string): void => {
    if (reportedOrigins.has(origin)) return;
    reportedOrigins.add(origin);
    console.warn(
      `\u26a0\ufe0f CORS: refused origin ${JSON.stringify(origin)}. Allowlist: ${JSON.stringify(
        originAllowlist.entries,
      )}. Add it to CORS_ORIGINS if it is one of your own deployments (a single * wildcard is supported per entry).`,
    );
  };

  // A preflight from a disallowed origin must not be handed to next(): the cors
  // package attaches no headers in that case, so the request would land on the
  // 404 handler and the browser would report an empty
  // Access-Control-Allow-Credentials header - true, but useless for debugging.
  // Answering here makes the refusal explicit and greppable.
  app.options('*', (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || originAllowlist.isAllowed(origin)) return next();

    reportBlockedOrigin(origin);
    res.status(403).json({
      success: false,
      error: {
        message: `Origin ${origin} is not allowed by this server's CORS policy.`,
        code: 'ORIGIN_NOT_ALLOWED',
        statusCode: 403,
      },
    });
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: same-origin navigations, server-to-server calls,
        // health checks and CLI tools. These are not browser cross-site
        // requests, so they carry no CSRF risk from a reflected origin.
        if (!origin) return callback(null, true);

        if (originAllowlist.isAllowed(origin)) return callback(null, true);

        reportBlockedOrigin(origin);

        // Returning false omits the CORS headers and lets the browser block the
        // response. Passing an Error instead would surface as an unhandled 500
        // with a stack trace per attempt.
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // ---------------------
  // Parsing Middleware
  // ---------------------
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ---------------------
  // Logging
  // ---------------------
  if (config.isDevelopment) {
    app.use(morgan('dev'));
  } else {
    app.use(morgan('combined'));
  }

  // ---------------------
  // API Routes
  // ---------------------
  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/workspaces', workspaceRoutes);
  app.use('/api/workspaces/:workspaceId/files', fileRoutes);
  app.use('/api/workspaces/:workspaceId/chat', chatRoutes);
  app.use('/api/workspaces/:workspaceId/files/:fileId/versions', versionRoutes);

  // Root route
  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        name: 'Collaborative Code Editor API',
        version: '0.1.0',
        health: '/api/health',
        documentation: '/api',
      },
    });
  });

  // API Root route
  app.get('/api', (_req, res) => {
    res.json({
      success: true,
      data: {
        name: 'Collaborative Code Editor API',
        version: '0.1.0',
        documentation: '/api/health',
      },
    });
  });

  // ---------------------
  // 404 Handler
  // ---------------------
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: {
        message: 'Route not found',
        statusCode: 404,
      },
    });
  });

  // ---------------------
  // Error Handler
  // ---------------------
  app.use(errorHandler);

  return app;
}
