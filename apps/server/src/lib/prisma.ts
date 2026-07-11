import { PrismaClient } from '../generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/index.js';

// Instantiate the adapter — Prisma v7 PrismaPg manages Pool internally
const adapter = new PrismaPg({ connectionString: config.databaseUrl });

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
