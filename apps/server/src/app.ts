import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspace.js';
import fileRoutes from './routes/file.js';
import chatRoutes from './routes/chat.js';
import versionRoutes from './routes/version.js';

/**
 * Turns a CORS_ORIGINS entry into a matcher.
 *
 * A single "*" is allowed so generated preview domains can be covered without
 * redeploying for every hostname, e.g. "https://my-app-*.vercel.app". The
 * wildcard expands to [A-Za-z0-9-]+, which matches exactly one hostname label
 * and deliberately excludes dots: without that restriction
 * "https://*.vercel.app" would also match "https://anything.evil.com.vercel.app"
 * style hosts, and this allowlist gates credentialed requests.
 */
function originPattern(entry: string): RegExp {
  const escaped = entry
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[A-Za-z0-9-]+');
  return new RegExp(`^${escaped}$`);
}

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
  // logged-in user, so the origin must be checked against config.corsOrigins.
  const rawOrigins = config.corsOrigins
    .map((origin) => origin.trim())
    .filter(Boolean);

  const exactOrigins = new Set(rawOrigins.filter((origin) => !origin.includes('*')));
  const wildcardOrigins = rawOrigins
    .filter((origin) => origin.includes('*'))
    .map(originPattern);

  const isAllowedOrigin = (origin: string): boolean =>
    exactOrigins.has(origin) || wildcardOrigins.some((pattern) => pattern.test(origin));

  // Blocked origins already reported. One misconfigured client retrying in a
  // loop should not bury the rest of the log.
  const reportedOrigins = new Set<string>();

  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: same-origin navigations, server-to-server calls,
        // health checks and CLI tools. These are not browser cross-site
        // requests, so they carry no CSRF risk from a reflected origin.
        if (!origin) return callback(null, true);

        if (isAllowedOrigin(origin)) return callback(null, true);

        // Passing an Error here handed it to next(), so every blocked request
        // became an unhandled 500 with a full stack trace — while the response
        // still lacked the CORS headers the browser needs. The client saw an
        // opaque network failure with no body to read an error message from.
        // Returning false attaches no CORS headers and lets the browser do the
        // blocking, which is what the spec expects.
        if (!reportedOrigins.has(origin)) {
          reportedOrigins.add(origin);
          console.warn(
            `⚠️ CORS: blocked request from origin ${origin}. If this is one of your own deployments, add it to CORS_ORIGINS (wildcards allowed, e.g. https://my-app-*.vercel.app).`,
          );
        }

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
