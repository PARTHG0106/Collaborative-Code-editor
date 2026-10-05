import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma.js';
import authRoutes from './auth.js';
import workspaceRoutes from './workspace.js';
import { config } from '../config/index.js';

const database = vi.hoisted(() => ({
  db: undefined as { exec: (sql: string) => Promise<unknown>; close: () => Promise<void> } | undefined,
}));
vi.mock('../config/index.js', async original => {
  const actual = await original<typeof import('../config/index.js')>();
  return { ...actual, config: { ...actual.config, googleClientId: 'test-client.apps.googleusercontent.com' } };
});
vi.mock('../utils/mailer.js', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/prisma.js', async () => {
  const [{ PGlite }, { default: pg }, { PrismaPg }, { PrismaClient }, { EventEmitter }] = await Promise.all([
    import('@electric-sql/pglite'), import('pg'), import('@prisma/adapter-pg'),
    import('../generated/client/index.js'), import('node:events'),
  ]);
  const db = await PGlite.create();
  database.db = db;
  // Keep the production Prisma client/adapter and SQL unchanged. This small
  // transport bridge sends node-pg queries to isolated WASM PostgreSQL, with
  // the same result parsers the production adapter requests from node-pg.
  // Tests run sequentially because PGlite owns one database connection.
  type Query = {
    text: string; values?: unknown[]; rowMode?: 'array';
    types?: { getTypeParser: (oid: number, format: 'text') => (value: string) => unknown };
  };
  const pool = new pg.Pool();
  pool.query = (async (query: string | Query, values?: unknown[]) => {
    const options = typeof query === 'string' ? { text: query } : query;
    const parsers = options.types ? Object.fromEntries(Object.values(pg.types.builtins)
      .map(oid => [oid, options.types!.getTypeParser(oid, 'text')])) : undefined;
    const result = await db.query(options.text, values ?? options.values, { rowMode: options.rowMode, parsers });
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }) as typeof pool.query;
  const connection = Object.assign(new EventEmitter(), {
    query: pool.query.bind(pool), release: () => {},
  });
  pool.connect = (async () => connection) as unknown as typeof pool.connect;
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  return { default: client, prisma: client };
});

const app = express();
app.use(express.json(), cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
const clientId = 'test-client.apps.googleusercontent.com';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const password = 'existing-password-123';
let passwordHash: string;
let certSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const migrations = path.resolve(__dirname, '../../prisma/migrations');
  for (const entry of fs.readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    await database.db!.exec(fs.readFileSync(path.join(migrations, entry.name, 'migration.sql'), 'utf8'));
  }
  passwordHash = await bcrypt.hash(password, 6);
  certSpy = vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
    certs: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, format: 'PEM',
  } as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>);
});

beforeEach(async () => {
  await database.db!.exec('TRUNCATE users, workspaces, google_auth_challenges CASCADE');
});

afterAll(async () => {
  certSpy?.mockRestore();
  await prisma.$disconnect();
  await database.db?.close();
});

async function seedAccount(email: string, isVerified = true) {
  const user = await prisma.user.create({ data: {
    email, name: 'Original Profile', passwordHash, isVerified,
    ...(isVerified ? {} : { verificationToken: '123456', verificationExpires: new Date(Date.now() + 60000) }),
  } });
  const workspace = await prisma.workspace.create({ data: {
    name: 'Existing project', members: { create: { userId: user.id, role: 'OWNER' } },
    fileSystemItems: { create: { name: 'main.ts', type: 'FILE', content: 'original code' } },
  } });
  return { user, workspace };
}

async function googleLogin(email: string, hd?: string) {
  const challenge = await request(app).post('/api/auth/google/challenge')
    .set('Origin', 'http://localhost:5173').send({});
  expect(challenge.status).toBe(200);
  const cookie = (challenge.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const browserSecret = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const storedChallenge = await prisma.googleAuthChallenge.findUnique({
    where: { tokenHash: createHash('sha256').update(browserSecret).digest('hex') },
  });
  expect(storedChallenge).not.toBeNull();
  expect(storedChallenge!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  const credential = jwt.sign({
    iss: 'https://accounts.google.com', aud: clientId, sub: 'same-google-subject',
    email, email_verified: true, name: 'Google Profile', nonce: challenge.body.data.nonce,
    ...(hd ? { hd } : {}),
  }, keys.privateKey, { algorithm: 'RS256', keyid: 'test', expiresIn: '1h' });
  return request(app).post('/api/auth/google')
    .set('Origin', 'http://localhost:5173')
    .set('Cookie', cookie)
    .send({ credential });
}

describe('Google links to the existing password account through PostgreSQL and HTTP', () => {
  it.each([
    ['Coder@Gmail.com', 'coder@gmail.com', undefined],
    ['Coder@Company.com', 'coder@company.com', 'company.com'],
  ])('keeps the same id, password and workspace for %s', async (existingEmail, googleEmail, hd) => {
    const { user, workspace } = await seedAccount(existingEmail);
    const initialLogin = await request(app).post('/api/auth/login').send({ email: existingEmail, password });
    expect(initialLogin.status).toBe(200);
    expect(initialLogin.body.data.user.id).toBe(user.id);
    const originalMemberships = await prisma.workspaceMember.findMany({ where: { userId: user.id } });

    const google = await googleLogin(googleEmail, hd);
    expect(google.body).toMatchObject({ success: true });
    expect(google.status).toBe(200);
    expect(google.body.data.user).toEqual({ id: user.id, email: existingEmail, name: user.name });
    expect(jwt.verify(google.body.data.accessToken, config.jwt.accessSecret)).toMatchObject({ userId: user.id });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({
      email: existingEmail, name: user.name, passwordHash, googleSubject: 'same-google-subject', isVerified: true,
    });
    expect(await prisma.workspaceMember.findMany({ where: { userId: user.id } })).toEqual(originalMemberships);
    const workspaces = await request(app).get('/api/workspaces')
      .set('Authorization', `Bearer ${google.body.data.accessToken}`);
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.data).toEqual([expect.objectContaining({ id: workspace.id, name: 'Existing project', role: 'OWNER' })]);
    expect(await prisma.fileSystemItem.findMany({ where: { workspaceId: workspace.id } })).toEqual([
      expect.objectContaining({ name: 'main.ts', content: 'original code' }),
    ]);
    const refreshCookie = (google.headers['set-cookie'] as unknown as string[]).find(cookie => cookie.startsWith('refreshToken='))!;
    const refreshToken = decodeURIComponent(refreshCookie.split(';')[0].slice('refreshToken='.length));
    expect(await prisma.refreshToken.findFirst({ where: { tokenHash: createHash('sha256').update(refreshToken).digest('hex') } }))
      .toMatchObject({ userId: user.id });

    const passwordLogin = await request(app).post('/api/auth/login').send({ email: existingEmail, password });
    expect(passwordLogin.status).toBe(200);
    expect(passwordLogin.body.data.user.id).toBe(user.id);
    const returningGoogle = await googleLogin(googleEmail, hd);
    expect(returningGoogle.status).toBe(200);
    expect(returningGoogle.body.data.user.id).toBe(user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it('requires existing-account verification without duplicating or activating an unfinished password account', async () => {
    const { user } = await seedAccount('Coder@Gmail.com', false);
    const originalMemberships = await prisma.workspaceMember.findMany({ where: { userId: user.id } });
    const response = await googleLogin('coder@gmail.com');
    expect(response.body).toMatchObject({ error: { message: expect.stringContaining('awaiting verification') } });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('awaiting verification');
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toEqual(user);
    expect(await prisma.refreshToken.count()).toBe(0);
    expect(await prisma.workspaceMember.findMany({ where: { userId: user.id } })).toEqual(originalMemberships);
  });
});
