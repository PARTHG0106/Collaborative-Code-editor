import { createApp } from './app.js';
import { config, validateConfig } from './config/index.js';
import prisma from './lib/prisma.js';

/**
 * Server entry point.
 * Validates configuration, connects to database, and starts listening.
 */
async function main(): Promise<void> {
  try {
    // Validate environment variables
    validateConfig();
    console.info('✅ Configuration validated');

    // Test database connection
    await prisma.$connect();
    console.info('✅ Database connected');

    // Create and start Express app
    const app = createApp();

    const server = app.listen(config.port, () => {
      console.info(`
  ╔══════════════════════════════════════════════╗
  ║   Collaborative Code Editor API Server       ║
  ╠══════════════════════════════════════════════╣
  ║   🚀 Running on: http://localhost:${config.port}      ║
  ║   📋 Environment: ${config.nodeEnv.padEnd(23)}║
  ║   🔗 Health: http://localhost:${config.port}/api/health ║
  ╚══════════════════════════════════════════════╝
      `);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.info(`\n${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        await prisma.$disconnect();
        console.info('👋 Server shut down');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
