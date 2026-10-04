import type { ContentStore } from './d1ContentStore.js';

export interface ContentMigrationRow {
  id: string;
  content: string;
  contentKey: string | null;
  updatedAt?: Date;
}

/** The caller must atomically compare the original content/key/timestamp. */
export async function migrateContentRow(
  row: ContentMigrationRow,
  direction: 'backfill' | 'restore',
  store: ContentStore,
  compareAndSwap: (original: ContentMigrationRow, content: string, key: string | null) => Promise<boolean>,
): Promise<'changed' | 'unchanged' | 'raced'> {
  if (direction === 'backfill') {
    if (row.contentKey !== null) return 'unchanged';
    const key = await store.put(row.content);
    return await compareAndSwap(row, '', key) ? 'changed' : 'raced';
  }
  if (row.contentKey === null) return 'unchanged';
  const content = await store.get(row.contentKey);
  return await compareAndSwap(row, content, null) ? 'changed' : 'raced';
}
