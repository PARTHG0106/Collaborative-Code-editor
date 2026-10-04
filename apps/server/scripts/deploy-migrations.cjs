'use strict';

// Older releases used db push. Baseline only the verified, completed June
// schema; never claim that arbitrary pending migrations have already run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HISTORICAL_CHECKPOINT = [
  '20260619114543_init_auth',
  '20260619120559_add_workspace_models',
  '20260619125748_add_workspaces',
  '20260619150759_add_file_system',
  '20260619164653_add_chat_and_versions',
  '20260619171126_add_email_verification',
];

class MigrationPreflightError extends Error {}
const c = (type = 'text', nullable = false, defaultValue) => ({ type, nullable, defaultValue });
const timestamp = (nullable = false, defaultValue) => c('timestamp', nullable, defaultValue);
const created = () => timestamp(false, 'now');
const identity = () => ({ id: c() });
const timestamps = () => ({ created_at: created(), updated_at: timestamp() });

const BASE_TABLES = {
  health_checks: { ...identity(), status: c('text', false, 'ok'), checked_at: created() },
  users: {
    ...identity(), email: c(), password_hash: c(), name: c(), ...timestamps(),
    is_verified: c('bool', false, false), verification_token: c('text', true), verification_expires: timestamp(true),
  },
  refresh_tokens: {
    ...identity(), user_id: c(), expires_at: timestamp(), revoked: c('bool', false, false), created_at: created(),
  },
  workspaces: { ...identity(), name: c(), description: c('text', true), ...timestamps() },
  workspace_members: {
    ...identity(), workspace_id: c(), user_id: c(), role: c('WorkspaceRole', false, 'VIEWER'), joined_at: created(),
  },
  file_system_items: {
    ...identity(), name: c(), type: c('FileSystemItemType'), content: c('text', true), parent_id: c('text', true),
    workspace_id: c(), ...timestamps(),
  },
  chat_messages: { ...identity(), workspace_id: c(), user_id: c(), message: c(), created_at: created() },
  file_versions: {
    ...identity(), file_id: c(), content: c(), version: c('int4'), user_id: c('text', true), created_at: created(),
  },
};

const EXECUTION_TABLES = {
  execution_sessions: {
    ...identity(), workspace_id: c(), file_id: c('text', true), user_id: c(), language: c(), target: c('ExecutionTarget'),
    status: c('ExecutionStatus', false, 'QUEUED'), code: c(), stdin: c('text', true), stdout: c('text', true),
    stderr: c('text', true), exit_code: c('int4', true), started_at: timestamp(true), completed_at: timestamp(true),
    duration_ms: c('int4', true), created_at: created(),
  },
  execution_agents: {
    ...identity(), user_id: c(), name: c('text', false, 'My Machine'), last_seen: created(),
    is_online: c('bool', false, false), runtimes: c('_text', true), platform: c('text', true), version: c('text', true), created_at: created(),
  },
  notebook_sessions: {
    ...identity(), workspace_id: c(), file_id: c(), user_id: c(), kernel_state: c('text', true), outputs: c('jsonb', true), ...timestamps(),
  },
  terminal_sessions: {
    ...identity(), workspace_id: c(), user_id: c(), target: c('ExecutionTarget'), is_active: c('bool', false, true),
    created_at: created(), closed_at: timestamp(true),
  },
  execution_workers: {
    ...identity(), url: c(), account: c(), type: c(), status: c(), last_heartbeat: created(),
    active_jobs: c('int4', false, 0), daily_failures: c('int4', false, 0), created_at: created(),
  },
};

const ENUMS = {
  WorkspaceRole: ['OWNER', 'EDITOR', 'VIEWER'],
  FileSystemItemType: ['FILE', 'FOLDER'],
  ExecutionStatus: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
  ExecutionTarget: ['BROWSER', 'LOCAL_AGENT', 'REMOTE', 'CPU_WORKER', 'GPU_WORKER'],
};
const BASE_UNIQUE = [
  ['users', ['email']],
  ['workspace_members', ['workspace_id', 'user_id']],
  ['file_system_items', ['workspace_id', 'parent_id', 'name']],
];
const EXECUTION_UNIQUE = [
  ['execution_agents', ['user_id']], ['notebook_sessions', ['workspace_id', 'file_id']], ['execution_workers', ['url']],
];
const FINAL_INDEXES = [
  ['workspace_members', ['user_id']], ['chat_messages', ['workspace_id', 'created_at']],
  ['file_versions', ['file_id', 'created_at']], ['refresh_tokens', ['user_id']],
  ['refresh_tokens', ['expires_at']], ['refresh_tokens', ['token_hash']], ['file_system_items', ['parent_id']],
  ['execution_sessions', ['workspace_id']], ['execution_sessions', ['user_id']], ['terminal_sessions', ['workspace_id']],
];
const FOREIGN_KEYS = [
  ['refresh_tokens', 'user_id', 'users', 'c'],
  ['workspace_members', 'workspace_id', 'workspaces', 'c'],
  ['workspace_members', 'user_id', 'users', 'c'],
  ['file_system_items', 'parent_id', 'file_system_items', 'c'],
  ['file_system_items', 'workspace_id', 'workspaces', 'c'],
  ['chat_messages', 'workspace_id', 'workspaces', 'c'],
  ['chat_messages', 'user_id', 'users', 'c'],
  ['file_versions', 'file_id', 'file_system_items', 'c'],
  ['file_versions', 'user_id', 'users', 'n'],
];

async function inspectSchema(db) {
  // Sequential queries also work with single-connection PostgreSQL adapters.
  const tables = (await db.query(`
    SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `)).rows.map(row => row.table_name);
  const columns = (await db.query(`
    SELECT table_name, column_name, udt_name, udt_schema, is_nullable, datetime_precision, column_default
    FROM information_schema.columns WHERE table_schema = 'public'
  `)).rows;
  const enums = (await db.query(`
    SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public' GROUP BY t.typname
  `)).rows;
  const indexes = (await db.query(`
    SELECT t.relname AS table_name, i.relname AS index_name, x.indisunique AS is_unique, x.indisprimary AS is_primary,
      x.indisvalid AS is_valid, x.indisready AS is_ready, x.indpred IS NULL AS is_full,
      x.indexprs IS NULL AS no_expressions, am.amname AS method,
      ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE k.position <= x.indnkeyatts ORDER BY k.position) AS columns
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public'
  `)).rows;
  const foreignKeys = (await db.query(`
    SELECT t.relname AS table_name, rt.relname AS target_table, rn.nspname AS target_schema,
      f.confdeltype AS on_delete, f.confupdtype AS on_update, f.convalidated AS is_valid,
      ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.position) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = k.attnum ORDER BY k.position) AS target_columns
    FROM pg_constraint f JOIN pg_class t ON t.oid = f.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class rt ON rt.oid = f.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
    WHERE n.nspname = 'public' AND f.contype = 'f'
  `)).rows;
  return { tables, columns, enums, indexes, foreignKeys };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function defaultMatches(actual, expected) {
  if (expected === undefined) return true;
  const value = (actual || '').trim();
  if (expected === 'now') return /^(CURRENT_TIMESTAMP|now\(\))$/i.test(value);
  if (typeof expected === 'boolean' || typeof expected === 'number') return value === String(expected);
  return value === `'${expected}'` || value.startsWith(`'${expected}'::`);
}

function validateSchema(schema, { final = false } = {}) {
  const failures = [];
  const column = (table, name) => schema.columns.find(item => item.table_name === table && item.column_name === name);
  const hasIndex = (table, columns, { unique = false, primary = false } = {}) => schema.indexes.some(index => (
    index.table_name === table && same(index.columns, columns) && index.is_valid && index.is_ready && index.is_full
    && index.no_expressions && index.method === 'btree' && (!unique || index.is_unique) && (!primary || index.is_primary)
  ));
  const checkColumn = (table, name, expected) => {
    const actual = column(table, name);
    if (!actual) { failures.push(`Missing column ${table}.${name}`); return; }
    const typeSchema = Object.hasOwn(ENUMS, expected.type) ? 'public' : 'pg_catalog';
    if (actual.udt_name !== expected.type || actual.udt_schema !== typeSchema
      || (actual.is_nullable === 'YES') !== expected.nullable
      || (expected.type === 'timestamp' && actual.datetime_precision !== 3)
      || !defaultMatches(actual.column_default, expected.defaultValue)) {
      failures.push(`Incompatible definition for ${table}.${name}`);
    }
  };
  for (const [table, columns] of Object.entries({ ...BASE_TABLES, ...EXECUTION_TABLES })) {
    const required = Object.hasOwn(BASE_TABLES, table) || final;
    if (!schema.tables.includes(table)) {
      if (required) failures.push(`Missing table ${table}`);
      continue;
    }
    for (const [name, expected] of Object.entries(columns)) checkColumn(table, name, expected);
    if (!hasIndex(table, ['id'], { primary: true })) failures.push(`Missing primary key on ${table}.id`);
  }
  for (const [name, labels] of Object.entries(ENUMS)) {
    const actual = schema.enums.find(item => item.name === name);
    if (actual ? !same(actual.labels, labels) : final || name === 'WorkspaceRole' || name === 'FileSystemItemType') {
      failures.push(`Missing or incompatible enum ${name}`);
    }
  }
  for (const [table, columns] of BASE_UNIQUE) {
    if (!hasIndex(table, columns, { unique: true })) failures.push(`Missing unique key on ${table}(${columns.join(', ')})`);
  }
  for (const [table, columns] of EXECUTION_UNIQUE) {
    // Missing indexes on existing execution tables can be added safely by the
    // new migration. Their columns and primary keys must already be compatible.
    if (final && !hasIndex(table, columns, { unique: true })) failures.push(`Missing unique key on ${table}(${columns.join(', ')})`);
  }
  for (const [table, name, target, onDelete] of FOREIGN_KEYS) {
    if (!schema.foreignKeys.some(key => key.table_name === table && same(key.columns, [name])
      && key.target_schema === 'public' && key.target_table === target && same(key.target_columns, ['id'])
      && key.is_valid && key.on_delete === onDelete && key.on_update === 'c')) {
      failures.push(`Missing or incompatible foreign key ${table}.${name}`);
    }
  }
  const token = column('refresh_tokens', 'token');
  const tokenHash = column('refresh_tokens', 'token_hash');
  if (token && tokenHash) failures.push('Both raw and hashed refresh-token columns exist; manual review is required');
  else if (tokenHash) checkColumn('refresh_tokens', 'token_hash', c('text', true));
  else if (token && !final) {
    checkColumn('refresh_tokens', 'token', c());
    if (!hasIndex('refresh_tokens', ['token'], { unique: true })) failures.push('Missing unique key on refresh_tokens.token');
  } else failures.push('Missing compatible refresh-token storage');

  // These June intermediate objects should have been removed together. Their
  // presence means the completed checkpoint has not actually been reached.
  if (schema.tables.includes('workspace_invitations')) failures.push('Intermediate workspace_invitations table still exists');
  for (const name of ['created_at', 'updated_at']) {
    if (column('workspace_members', name)) failures.push(`Intermediate workspace_members.${name} column still exists`);
  }
  for (const table of ['file_system_items', 'file_versions']) {
    if (final || column(table, 'content_key')) checkColumn(table, 'content_key', c('text', true));
  }
  if (final) {
    for (const [table, columns] of FINAL_INDEXES) {
      if (!hasIndex(table, columns)) failures.push(`Missing index on ${table}(${columns.join(', ')})`);
    }
  }
  if (failures.length) throw new MigrationPreflightError(`Schema verification failed; no migration history was inferred:\n${failures.join('\n')}`);
}

function readMigrations(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const sql = fs.readFileSync(path.join(directory, entry.name, 'migration.sql'), 'utf8');
    const lf = sql.replace(/\r\n/g, '\n');
    const checksums = new Set([sql, lf, lf.replace(/\n/g, '\r\n')].map(text => crypto.createHash('sha256').update(text).digest('hex')));
    return { name: entry.name, sql, checksums };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function planDeployment(schema, history, migrations) {
  const applied = new Set();
  for (const row of history) {
    if (!row.finished_at && !row.rolled_back_at) {
      throw new MigrationPreflightError(`Migration ${row.migration_name} is unfinished. Review and resolve it explicitly before deployment.`);
    }
    if (row.rolled_back_at || !row.finished_at) continue;
    const local = migrations.find(migration => migration.name === row.migration_name);
    if (!local || !local.checksums.has(row.checksum)) {
      throw new MigrationPreflightError(`Applied migration ${row.migration_name} is missing locally or has a different checksum.`);
    }
    applied.add(row.migration_name);
  }
  const userTables = schema.tables.filter(name => name !== '_prisma_migrations');
  if (!userTables.length && !applied.size && !schema.enums.length) return { baseline: [] };
  validateSchema(schema);
  const baseline = HISTORICAL_CHECKPOINT.filter(name => !applied.has(name));
  if (baseline.some(name => !migrations.some(migration => migration.name === name))) {
    throw new MigrationPreflightError('The verified historical checkpoint is missing a migration file.');
  }
  return { baseline };
}

async function readHistory(db, schema) {
  if (!schema.tables.includes('_prisma_migrations')) return [];
  return (await db.query(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations`)).rows;
}

function databaseOptions(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new MigrationPreflightError('A valid DATABASE_URL or DIRECT_URL is required for migrations.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new MigrationPreflightError('Migrations require a PostgreSQL database URL.');
  if (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') {
    throw new MigrationPreflightError('The committed migrations target the public schema; refusing to migrate a different schema.');
  }
  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('schema');
  // pg and Prisma interpret sslmode=require differently. Preserve libpq's
  // require/verify distinction instead of pg upgrading require to verify-full.
  url.searchParams.delete('sslmode');
  const ssl = mode === 'disable' ? false : mode ? { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' } : undefined;
  return { connectionString: url.toString(), connectionTimeoutMillis: 15000, ...(ssl !== undefined ? { ssl } : {}) };
}

function runPrisma(args, { cwd, databaseUrl }) {
  const cli = require.resolve('prisma/build/index.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'migrate', ...args], {
      cwd, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', () => reject(new MigrationPreflightError('Could not start the Prisma migration CLI.')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new MigrationPreflightError(`Prisma migrate ${args[0]} did not complete (exit ${code ?? signal}).`));
    });
  });
}

async function deploy({ db, migrations, run, log = console.info }) {
  const schema = await inspectSchema(db);
  const history = await readHistory(db, schema);
  const { baseline } = planDeployment(schema, history, migrations);
  if (baseline.length) log(`Verified the completed June schema. Recording ${baseline.length} missing historical checkpoint entries.`);
  for (const name of baseline) await run(['resolve', '--applied', name]);
  await run(['deploy']);
  validateSchema(await inspectSchema(db), { final: true });
  log('Database migrations and schema verification completed.');
}

async function main() {
  const cwd = path.resolve(__dirname, '..');
  require('dotenv').config({ path: path.resolve(cwd, '../../.env') });
  const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const { Client } = require('pg');
  const db = new Client(databaseOptions(databaseUrl));
  await db.connect();
  try {
    // Serialize baseline + deploy across overlapping application restarts.
    // A transaction-scoped lock also works through transaction poolers: a
    // session lock could remain attached to an unrelated pooled connection.
    // Prisma uses its own distinct lock on its separate migration connection.
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '120s'");
    await db.query('SELECT pg_advisory_xact_lock(192837465, 61004)');
    await deploy({
      db, migrations: readMigrations(path.join(cwd, 'prisma/migrations')),
      run: args => runPrisma(args, { cwd, databaseUrl }),
    });
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await db.end(); }
}

module.exports = { HISTORICAL_CHECKPOINT, MigrationPreflightError, inspectSchema, validateSchema, readMigrations, planDeployment, databaseOptions, deploy };
if (require.main === module) {
  main().catch(error => {
    // Driver errors can contain connection details. Print only our own
    // controlled diagnostics, never a raw DATABASE_URL or driver exception.
    console.error(error instanceof MigrationPreflightError ? error.message : 'Database migration preflight could not complete. Check database connectivity, permissions, and server logs.');
    process.exitCode = 1;
  });
}
