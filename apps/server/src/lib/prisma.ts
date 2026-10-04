import { PrismaClient } from '../generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/index.js';
import { contentStorageFromEnv } from './d1ContentStore.js';
import { contentStorageExtension } from './contentStorageExtension.js';

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

// Raw client is reserved for migration tooling. Application code must use the
// extended client so D1 references are resolved before content reaches callers.
export const prismaMetadata =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaMetadata;
}

export const prisma = prismaMetadata.$extends(contentStorageExtension(contentStorageFromEnv()));

export default prisma;
