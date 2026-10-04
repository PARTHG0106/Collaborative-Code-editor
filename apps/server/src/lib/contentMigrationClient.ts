import { createRequire } from 'node:module';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import { PrismaClient } from '../generated/client/index.js';

const load = createRequire(path.join(__dirname, 'contentMigrationClient.js'));
const { databaseOptions } = load('../../scripts/deploy-migrations.cjs') as {
  databaseOptions: (url?: string) => PoolConfig;
};

/** Maintenance needs neither application JWT secrets nor query/error logging. */
export function createContentMigrationClient(env: NodeJS.ProcessEnv = process.env): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(databaseOptions(env.DIRECT_URL || env.DATABASE_URL)),
    log: [],
  });
}
