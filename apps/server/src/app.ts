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
  const allowedOrigins = new Set(
    config.corsOrigins.map((origin) => origin.trim()).filter(Boolean),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: same-origin navigations, server-to-server calls,
        // health checks and CLI tools. These are not browser cross-site
        // requests, so they carry no CSRF risk from a reflected origin.
        if (!origin) return callback(null, true);

        if (allowedOrigins.has(origin)) return callback(null, true);

        return callback(new Error(`Origin not allowed by CORS: ${origin}`));
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
