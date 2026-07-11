import { PrismaClient } from '../generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/index.js';

// Pass PoolConfig to PrismaPg — it creates its own Pool internally.
// We pass ssl: { rejectUnauthorized: false } to handle Supabase certs,
// and use config.databaseUrl which has sslmode stripped from the query string.
const adapter = new PrismaPg({
  connectionString: config.databaseUrl,
  ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

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
