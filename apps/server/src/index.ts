import { createServer } from 'http';
import pg from 'pg';
import { createApp } from './app.js';
import { config, validateConfig } from './config/index.js';
import prisma from './lib/prisma.js';
import { initSocketServer } from './socket.js';

/**
 * Server entry point with detailed checkpoint logging.
 */
async function main(): Promise<void> {
  try {
    // ──────────────────────────────────────────
    // CHECKPOINT 1: Environment variables
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 1] Validating environment variables...');
    validateConfig();
    console.info('✅ [CHECKPOINT 1] Configuration validated');
    console.info(`   PORT=${config.port}, NODE_ENV=${config.nodeEnv}`);
    console.info(`   DATABASE_URL set: ${!!config.databaseUrl}`);
    console.info(`   JWT secrets set: access=${!!config.jwt.accessSecret}, refresh=${!!config.jwt.refreshSecret}`);
    console.info(`   CORS origins: ${JSON.stringify(config.corsOrigins)}`);

    // ──────────────────────────────────────────
    // CHECKPOINT 2: Raw pg connection to Supabase
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 2] Testing raw pg connection to Supabase...');
    try {
      const testPool = new pg.Pool({
        connectionString: config.databaseUrl,
        ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        max: 1,
        connectionTimeoutMillis: 10000,
      });
      const client = await testPool.connect();
      const result = await client.query('SELECT NOW() AS now, current_database() AS db, current_schema() AS schema');
      console.info('✅ [CHECKPOINT 2] Supabase raw pg works!');
      console.info(`   DB: ${result.rows[0].db}, Schema: ${result.rows[0].schema}, Time: ${result.rows[0].now}`);
      client.release();
      await testPool.end();
    } catch (pgErr: any) {
      console.error('❌ [CHECKPOINT 2] Raw pg connection FAILED:', pgErr.message);
      console.error('   Full error:', pgErr);
      throw pgErr;
    }

    // ──────────────────────────────────────────
    // CHECKPOINT 3: Prisma $connect
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 3] Testing Prisma $connect...');
    await prisma.$connect();
    console.info('✅ [CHECKPOINT 3] Prisma $connect works!');

    // ──────────────────────────────────────────
    // CHECKPOINT 4: Prisma query (SELECT 1)
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 4] Testing Prisma $queryRaw...');
    try {
      const queryResult = await prisma.$queryRaw`SELECT 1 AS ok`;
      console.info('✅ [CHECKPOINT 4] Prisma $queryRaw works!', queryResult);
    } catch (queryErr: any) {
      console.error('❌ [CHECKPOINT 4] Prisma $queryRaw FAILED:', queryErr.message);
      console.error('   Error name:', queryErr.name);
      console.error('   Error code:', queryErr.code);
      console.error('   Full error:', JSON.stringify(queryErr, null, 2));
      // Don't throw — continue to see if model queries work
    }

    // ──────────────────────────────────────────
    // CHECKPOINT 5: Prisma model query (users table)
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 5] Testing Prisma model query (user.count)...');
    try {
      const userCount = await prisma.user.count();
      console.info(`✅ [CHECKPOINT 5] Prisma model query works! User count: ${userCount}`);
    } catch (modelErr: any) {
      console.error('❌ [CHECKPOINT 5] Prisma model query FAILED:', modelErr.message);
      console.error('   Error name:', modelErr.name);
      console.error('   Error code:', modelErr.code);
      console.error('   Full error:', JSON.stringify(modelErr, null, 2));
      // Don't throw — continue to start the server anyway
    }

    // ──────────────────────────────────────────
    // CHECKPOINT 6: Express app creation
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 6] Creating Express app...');
    const app = createApp();
    console.info('✅ [CHECKPOINT 6] Express app created!');

    // ──────────────────────────────────────────
    // CHECKPOINT 7: Socket.IO + HTTP server
    // ──────────────────────────────────────────
    console.info('🔍 [CHECKPOINT 7] Initializing HTTP server + Socket.IO...');
    const server = createServer(app);
    initSocketServer(server);
    console.info('✅ [CHECKPOINT 7] Socket.IO initialized!');

    // ──────────────────────────────────────────
    // CHECKPOINT 8: Start listening
    // ──────────────────────────────────────────
    server.listen(config.port, '0.0.0.0', () => {
      console.info(`✅ [CHECKPOINT 8] Server listening on port ${config.port}!`);
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
    try { await prisma.$disconnect(); } catch {}
    process.exit(1);
  }
}

main();
