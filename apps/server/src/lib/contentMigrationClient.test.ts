import { describe, expect, it, vi } from 'vitest';

const clients = vi.hoisted(() => ({ prisma: vi.fn(), adapter: vi.fn() }));
vi.mock('../generated/client/index.js', () => ({ PrismaClient: clients.prisma }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: clients.adapter }));
// Importing the application configuration from maintenance is a regression:
// it requires JWT secrets and the app client may log file contents in errors.
vi.mock('../config/index.js', () => { throw new Error('Application config must not load during maintenance'); });

import { createContentMigrationClient } from './contentMigrationClient.js';

describe('isolated content maintenance client', () => {
  it('needs only database settings and disables Prisma query/error logging', () => {
    createContentMigrationClient({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://test:test@localhost/content?sslmode=disable' });
    expect(clients.adapter).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionString: 'postgresql://test:test@localhost/content', ssl: false,
    }));
    expect(clients.prisma).toHaveBeenLastCalledWith(expect.objectContaining({ log: [] }));
  });

  it('uses the direct connection and the deployment schema/SSL checks', () => {
    createContentMigrationClient({
      DATABASE_URL: 'postgresql://test:test@localhost/pooled',
      DIRECT_URL: 'postgresql://test:test@localhost/direct?schema=public&sslmode=verify-full',
    });
    expect(clients.adapter).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionString: 'postgresql://test:test@localhost/direct', ssl: { rejectUnauthorized: true },
    }));
    expect(() => createContentMigrationClient({ DATABASE_URL: 'postgresql://test:test@localhost/content?schema=other' }))
      .toThrow('different schema');
    expect(() => createContentMigrationClient({})).toThrow('valid DATABASE_URL');
  });
});
