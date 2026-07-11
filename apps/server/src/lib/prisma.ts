import { PrismaClient } from '../generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from '../config/index.js';

// Create a native pg Pool
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

// Instantiate the adapter
const adapter = new PrismaPg(pool as any);

/**
 * Singleton Prisma client instance.
 * Prevents multiple client instantiations in development with hot-reloading.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
