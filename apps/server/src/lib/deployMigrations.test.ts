import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { types as pgTypes } from 'pg';

interface Migration { name: string; sql: string; checksums: Set<string> }
interface History { migration_name: string; checksum: string; finished_at: string | null; rolled_back_at: string | null }
interface Schema { tables: string[]; [key: string]: unknown }
const load = createRequire(path.join(__dirname, 'deployMigrations.test.ts'));
const { HISTORICAL_CHECKPOINT, inspectSchema, planDeployment, readMigrations, validateSchema, deploy, databaseOptions } =
  load('../../scripts/deploy-migrations.cjs') as {
    HISTORICAL_CHECKPOINT: string[];
    inspectSchema: (db: PGlite) => Promise<Schema>;
    planDeployment: (schema: Schema, history: History[], migrations: Migration[]) => { baseline: string[] };
    readMigrations: (directory: string) => Migration[];
    validateSchema: (schema: Schema, options?: { final?: boolean }) => void;
    deploy: (options: { db: PGlite; migrations: Migration[]; run: (args: string[]) => Promise<void>; log?: (message: string) => void }) => Promise<void>;
    databaseOptions: (url?: string) => { connectionString: string; ssl?: boolean | { rejectUnauthorized: boolean } };
  };

const migrations = readMigrations(path.resolve(__dirname, '../../prisma/migrations'));
const executionMigration = migrations.find(migration => migration.name.endsWith('_add_execution_models'))!;

describe('production migration preflight against PostgreSQL', () => {
  let db: PGlite;
  beforeAll(async () => { db = await PGlite.create(); });
  beforeEach(async () => { await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); });
  afterAll(async () => { await db.close(); });

  const applyJune = async () => {
    for (const name of HISTORICAL_CHECKPOINT) await db.exec(migrations.find(migration => migration.name === name)!.sql);
  };
  const seedContent = async () => {
    await db.exec(`
      INSERT INTO users (id, email, password_hash, name, updated_at) VALUES ('user', 'migration@example.test', 'password-hash', 'Migration Test', CURRENT_TIMESTAMP);
      INSERT INTO workspaces (id, name, updated_at) VALUES ('workspace', 'Keep this workspace', CURRENT_TIMESTAMP);
      INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ('member', 'workspace', 'user', 'OWNER');
      INSERT INTO file_system_items (id, name, type, content, workspace_id, updated_at) VALUES ('file', 'main.py', 'FILE', 'print(42)', 'workspace', CURRENT_TIMESTAMP);
      INSERT INTO file_versions (id, file_id, content, version, user_id) VALUES ('version', 'file', 'print(41)', 1, 'user');
    `);
  };
  const recordHistory = async (migration: Migration, { finished = true, checksum = [...migration.checksums][0] } = {}) => {
    await db.exec(`CREATE TABLE IF NOT EXISTS _prisma_migrations (
      migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TIMESTAMPTZ, rolled_back_at TIMESTAMPTZ
    )`);
    await db.query('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at) VALUES ($1, $2, $3)', [
      migration.name, checksum, finished ? '2026-10-04T00:00:00Z' : null,
    ]);
  };
  const prismaRunner = () => vi.fn(async (args: string[]) => {
    if (args[0] === 'resolve') {
      await recordHistory(migrations.find(migration => migration.name === args[2])!);
      return;
    }
    const schema = await inspectSchema(db);
    const rows = schema.tables.includes('_prisma_migrations')
      ? (await db.query<{ migration_name: string }>('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows : [];
    for (const migration of migrations) {
      if (rows.some(row => row.migration_name === migration.name)) continue;
      await db.exec(migration.sql);
      await recordHistory(migration);
    }
  });

  it('deploys every committed migration to an empty database without inventing baseline history', async () => {
    const run = prismaRunner();
    expect(planDeployment(await inspectSchema(db), [], migrations)).toEqual({ baseline: [] });
    await deploy({ db, migrations, run, log: vi.fn() });
    expect(run.mock.calls).toEqual([[['deploy']]]);
    validateSchema(await inspectSchema(db), { final: true });
    expect((await db.query('SELECT * FROM execution_workers')).rows).toEqual([]);
  });

  it('returns catalog arrays in a format decoded by the production node-pg driver', async () => {
    for (const migration of migrations) await db.exec(migration.sql);
    // PGlite decodes name[] itself; node-pg leaves that catalog-specific type
    // as a string. Exercise the production array parsers using real SQL type
    // metadata so an uncast pg_attribute.attname/pg_enum.enumlabel regresses.
    const wireDb = {
      async query(sql: string) {
        const result = await db.query<Record<string, unknown>>(sql);
        for (const field of result.fields) {
          if (field.dataTypeID !== 1003 && field.dataTypeID !== 1009) continue;
          for (const row of result.rows) {
            const value = row[field.name];
            if (Array.isArray(value)) {
              const wire = '{' + value.map(item => JSON.stringify(item)).join(',') + '}';
              // The runtime supports catalog/custom OIDs; @types/pg exposes
              // only its narrower list of named builtin scalar TypeId values.
              const parse = pgTypes.getTypeParser as (oid: number) => (text: string) => unknown;
              row[field.name] = parse(field.dataTypeID)(wire);
            }
          }
        }
        return result;
      },
    };
    validateSchema(await inspectSchema(wireDb as unknown as PGlite), { final: true });
  });

  it('baselines only the verified June checkpoint and preserves live content while upgrading token storage', async () => {
    await applyJune();
    await seedContent();
    await db.exec("INSERT INTO refresh_tokens (id, token, user_id, expires_at) VALUES ('refresh', 'legacy-session-secret', 'user', CURRENT_TIMESTAMP)");
    const run = prismaRunner();
    await deploy({ db, migrations, run, log: vi.fn() });
    expect(run.mock.calls).toEqual([
      ...HISTORICAL_CHECKPOINT.map(name => [['resolve', '--applied', name]]), [['deploy']],
    ]);
    expect((await db.query('SELECT content, content_key FROM file_system_items')).rows).toEqual([{ content: 'print(42)', content_key: null }]);
    expect((await db.query('SELECT content, version FROM file_versions')).rows).toEqual([{ content: 'print(41)', version: 1 }]);
    expect((await db.query('SELECT token_hash FROM refresh_tokens')).rows).toEqual([{
      token_hash: crypto.createHash('sha256').update('legacy-session-secret').digest('hex'),
    }]);
    run.mockClear();
    await deploy({ db, migrations, run, log: vi.fn() });
    expect(run.mock.calls).toEqual([[['deploy']]]);
    expect((await db.query('SELECT name FROM workspaces')).rows).toEqual([{ name: 'Keep this workspace' }]);
  });

  it('accepts the known hashed-token db-push schema and existing execution tables without losing rows', async () => {
    await applyJune();
    await seedContent();
    await db.exec(migrations.find(migration => migration.name.endsWith('_hash_refresh_tokens'))!.sql);
    await db.exec(executionMigration.sql);
    await db.exec(migrations.find(migration => migration.name.endsWith('_optional_d1_content'))!.sql);
    await db.exec(`INSERT INTO execution_sessions (id, workspace_id, user_id, language, target, code)
      VALUES ('existing-run', 'workspace', 'user', 'python', 'CPU_WORKER', 'print(42)')`);
    await deploy({ db, migrations, run: prismaRunner(), log: vi.fn() });
    expect((await db.query('SELECT id, code, target FROM execution_sessions')).rows).toEqual([
      { id: 'existing-run', code: 'print(42)', target: 'CPU_WORKER' },
    ]);
    await db.exec(executionMigration.sql);
    validateSchema(await inspectSchema(db), { final: true });
  });

  it('does not replay the destructive intermediate workspace migration against a partial schema', async () => {
    await db.exec(migrations[0].sql);
    await db.exec(migrations[1].sql);
    const run = vi.fn();
    await expect(deploy({ db, migrations, run, log: vi.fn() })).rejects.toThrow('Intermediate workspace_invitations');
    expect(run).not.toHaveBeenCalled();
    expect((await inspectSchema(db)).tables).toContain('workspace_invitations');
    expect((await inspectSchema(db)).tables).not.toContain('_prisma_migrations');
  });

  it.each([
    ['column nullability', 'ALTER TABLE users ALTER COLUMN name DROP NOT NULL', 'users.name'],
    ['column type', 'ALTER TABLE file_versions ALTER COLUMN version TYPE BIGINT', 'file_versions.version'],
    ['foreign-key semantics', 'ALTER TABLE file_versions DROP CONSTRAINT file_versions_file_id_fkey', 'file_versions.file_id'],
    ['unique key', 'DROP INDEX users_email_key', 'users(email)'],
    ['column default', 'ALTER TABLE users ALTER COLUMN is_verified SET DEFAULT true', 'users.is_verified'],
  ])('refuses baseline when %s differs from the known schema', async (_name, mutation, expectedError) => {
    await applyJune();
    await db.exec(mutation);
    const run = vi.fn();
    await expect(deploy({ db, migrations, run, log: vi.fn() })).rejects.toThrow(expectedError);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses to pretend that an incompatible execution table or enum has already been migrated', async () => {
    await applyJune();
    await db.exec(executionMigration.sql);
    await db.exec('ALTER TABLE execution_sessions DROP COLUMN code');
    const run = vi.fn();
    await expect(deploy({ db, migrations, run, log: vi.fn() })).rejects.toThrow('execution_sessions.code');
    expect(run).not.toHaveBeenCalled();
    await db.exec("ALTER TABLE execution_sessions ADD COLUMN code TEXT NOT NULL; ALTER TYPE \"ExecutionTarget\" RENAME VALUE 'REMOTE' TO 'UNKNOWN'");
    await expect(deploy({ db, migrations, run, log: vi.fn() })).rejects.toThrow('ExecutionTarget');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses unfinished, missing, and modified migration history before recording anything', async () => {
    await applyJune();
    const schema = await inspectSchema(db);
    const row: History = { migration_name: migrations[0].name, checksum: [...migrations[0].checksums][0], finished_at: null, rolled_back_at: null };
    expect(() => planDeployment(schema, [row], migrations)).toThrow('unfinished');
    expect(() => planDeployment(schema, [{ ...row, finished_at: '2026-10-04', checksum: 'wrong' }], migrations)).toThrow('different checksum');
    expect(() => planDeployment(schema, [{ ...row, finished_at: '2026-10-04', migration_name: 'unknown' }], migrations)).toThrow('missing locally');
    expect(planDeployment(schema, [{ ...row, finished_at: '2026-10-04' }], migrations)).toEqual({ baseline: HISTORICAL_CHECKPOINT.slice(1) });
  });

  it('checks the schema after deploy instead of treating a successful CLI exit as proof', async () => {
    await applyJune();
    const run = vi.fn(async () => {});
    await expect(deploy({ db, migrations, run, log: vi.fn() })).rejects.toThrow('Missing table execution_sessions');
  });

  it('refuses unknown schemas and keeps PostgreSQL SSL verification modes explicit', () => {
    expect(() => databaseOptions()).toThrow('valid DATABASE_URL');
    expect(() => databaseOptions('postgresql://user:secret@localhost/app?schema=other')).toThrow('different schema');
    expect(databaseOptions('postgresql://user:secret@localhost/app?schema=public&sslmode=verify-full')).toMatchObject({ ssl: { rejectUnauthorized: true } });
    expect(databaseOptions('postgresql://user:secret@localhost/app?sslmode=require')).toMatchObject({ ssl: { rejectUnauthorized: false } });
    expect(databaseOptions('postgresql://user:secret@localhost/app?sslmode=disable')).toMatchObject({ ssl: false });
  });
});
