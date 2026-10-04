import dotenv from 'dotenv';
import path from 'node:path';
import { D1Client, D1ContentStore } from '../src/lib/d1ContentStore.js';
import { migrateContentRow, type ContentMigrationRow } from '../src/lib/contentMigration.js';
import { createContentMigrationClient } from '../src/lib/contentMigrationClient.js';

// Injected environment takes precedence; the ignored D1-only file makes local
// maintenance possible without changing the app's normal database settings.
dotenv.config({ path: path.resolve(__dirname, '../../../.env.d1-local') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];
  const apply = args.includes('--apply');
  if (!['init', 'backfill', 'restore', 'verify'].includes(action) ||
      args.slice(1).some(arg => arg !== '--apply')) {
    console.info('Usage: npm run d1:content --workspace=apps/server -- <init|backfill|restore|verify> [--apply]');
    console.info('init/backfill/restore are read-only plans unless --apply is supplied. verify is always read-only.');
    return;
  }
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_D1_DATABASE_ID: databaseId, CLOUDFLARE_D1_API_TOKEN: apiToken } = process.env;
  if (!accountId || !databaseId || !apiToken) throw new Error('Set the three server-side CLOUDFLARE D1 environment variables first.');
  const d1 = new D1Client({ accountId, databaseId, apiToken });
  if (action === 'init') {
    if (apply) await d1.initialize();
    console.info(apply ? 'D1 content tables are ready.' : 'Plan: create the two D1 content tables if absent. Add --apply to initialize.');
    return;
  }

  // Never import the app client: its development query/error logs can include
  // file contents, and maintenance does not need application JWT secrets.
  const db = createContentMigrationClient();
  const store = new D1ContentStore(d1);
  const counts = { scanned: 0, inline: 0, remote: 0, changed: 0, raced: 0, verified: 0 };
  try {
    for (const model of ['file', 'version'] as const) {
      let cursor: string | undefined;
      for (;;) {
        // A Prisma cursor depends on the last row still existing. Use keyset
        // filtering so deleting that row cannot silently truncate verification.
        const paging = { take: 100, orderBy: { id: 'asc' as const } };
        const after = cursor ? { id: { gt: cursor } } : {};
        const rows = model === 'file'
          ? await db.fileSystemItem.findMany({ ...paging, where: { ...after, type: 'FILE', content: { not: null } }, select: { id: true, content: true, contentKey: true, updatedAt: true } })
          : await db.fileVersion.findMany({ ...paging, where: after, select: { id: true, content: true, contentKey: true } });
        if (!rows.length) break;
        for (const raw of rows) {
          const row: ContentMigrationRow = { ...raw, content: raw.content! };
          counts.scanned++;
          if (row.contentKey === null) counts.inline++;
          else counts.remote++;
          if (action === 'verify') {
            if (row.contentKey !== null) { await store.get(row.contentKey); counts.verified++; }
          } else if (apply) {
            const result = await migrateContentRow(row, action as 'backfill' | 'restore', store, async (original, content, key) => {
              const where = { id: original.id, content: original.content, contentKey: original.contentKey };
              const updated = model === 'file'
                ? await db.fileSystemItem.updateMany({ where: { ...where, updatedAt: original.updatedAt }, data: { content, contentKey: key, updatedAt: original.updatedAt } })
                : await db.fileVersion.updateMany({ where, data: { content, contentKey: key } });
              return updated.count === 1;
            });
            if (result === 'changed') counts.changed++;
            if (result === 'raced') counts.raced++;
          }
        }
        cursor = rows[rows.length - 1].id;
        console.info(`${model}: ${JSON.stringify(counts)}`);
      }
    }
    console.info(`${apply || action === 'verify' ? 'Completed' : 'Read-only plan'} ${action}: ${JSON.stringify(counts)}`);
    if (counts.raced) console.info('Some rows changed concurrently. Rerun to process remaining rows; no newer edits were overwritten.');
    if (action === 'restore' && apply) console.info('Keep D1 credentials until verify reports zero remote references. D1 blobs were retained for recovery.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Prisma errors can include connection strings or content parameters.
  // Fail without serializing raw provider/client exceptions.
  console.error(error instanceof Error && /^(D1 |Set the three|Stored content|File exceeds|Invalid D1)/.test(error.message)
    ? error.message : 'Content migration failed. No destructive cleanup was performed; check configuration and database availability.');
  process.exitCode = 1;
});
