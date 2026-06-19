import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';

/**
 * Creates and configures the Express application.
 * Separated from server startup for testability.
 */
export function createApp(): express.Application {
  const app = express();

  // ---------------------
  // Security Middleware
  // ---------------------
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
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

  // Root route
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
