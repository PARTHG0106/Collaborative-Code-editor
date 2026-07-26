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

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization';

/** How long a browser may cache a preflight result, in seconds. */
const PREFLIGHT_MAX_AGE = '600';

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
  for (const warning of originAllowlist.warnings) {
    console.warn(`\u26a0\ufe0f CORS_ORIGINS: ${warning}`);
  }

  if (originAllowlist.entries.length === 0) {
    console.warn(
      '\u26a0\ufe0f CORS_ORIGINS produced an empty allowlist. Every cross-origin browser request will be refused. The value must be a comma-separated list of origins such as https://example.com \u2014 not a URL with a path or query string.',
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

  /**
   * Preflight handling, done here rather than delegated to the cors package.
   *
   * A browser will not send a POST with a JSON body until an OPTIONS request
   * comes back carrying Access-Control-Allow-Credentials: true. Production
   * showed preflights arriving with that header empty while ordinary responses
   * from the same origin were fine, so the headers must not depend on the
   * library's internal control flow: in cors, an origin callback that yields
   * false results in a bare next() with no headers at all, and the request then
   * lands on the 404 handler.
   *
   * Requests without an Origin header are not browser cross-site requests and
   * are passed through untouched.
   */
  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') return next();

    const origin = req.headers.origin;

    // Logged unconditionally: if these lines never appear while a browser
    // reports a failed preflight, the OPTIONS request is being answered
    // upstream and never reaches this process.
    console.info(
      `\u2708\ufe0f CORS preflight ${req.originalUrl} origin=${origin ?? 'none'} requestHeaders=${
        req.headers['access-control-request-headers'] ?? 'none'
      }`,
    );

    if (!origin) return next();

    if (!originAllowlist.isAllowed(origin)) {
      reportBlockedOrigin(origin);
      res.status(403).json({
        success: false,
        error: {
          message: `Origin ${origin} is not allowed by this server's CORS policy.`,
          code: 'ORIGIN_NOT_ALLOWED',
          statusCode: 403,
        },
      });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader(
      'Access-Control-Allow-Headers',
      (req.headers['access-control-request-headers'] as string | undefined) ??
        DEFAULT_ALLOWED_HEADERS,
    );
    res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
    res.setHeader('Vary', 'Origin, Access-Control-Request-Headers');
    res.status(204).end();
  });

  // Actual (non-preflight) cross-origin responses still go through cors, which
  // handles the Allow-Origin and Allow-Credentials headers correctly for them.
  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: same-origin navigations, server-to-server calls,
        // health checks and CLI tools. These carry no CSRF risk from a
        // reflected origin.
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
