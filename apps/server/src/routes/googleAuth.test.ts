import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import authRoutes from './auth.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';
import { createGoogleChallenge, consumeGoogleChallenge, verifyGoogleCredential, resolveGoogleUser, GoogleSignInError } from '../lib/googleAuth.js';

vi.mock('../lib/prisma.js', () => ({ default: { user: { findUnique: vi.fn() }, refreshToken: { create: vi.fn() } } }));
vi.mock('../utils/mailer.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../config/index.js', async (original) => {
  const actual = await original<typeof import('../config/index.js')>();
  return { ...actual, config: { ...actual.config, googleClientId: 'test-client.apps.googleusercontent.com' } };
});
vi.mock('../lib/googleAuth.js', async (original) => ({
  ...await original<typeof import('../lib/googleAuth.js')>(),
  createGoogleChallenge: vi.fn(), consumeGoogleChallenge: vi.fn(), verifyGoogleCredential: vi.fn(), resolveGoogleUser: vi.fn(),
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json(), cookieParser());
app.use('/api/auth', authRoutes);
let addressCounter = 1;
let address: string;
const origin = 'http://localhost:5173';
const post = (path: string) => request(app).post(`/api/auth${path}`).set('Origin', origin).set('X-Forwarded-For', address);
const googleUser = {
  id: 'user', email: 'coder@gmail.com', name: 'Coder', passwordHash: null, googleSubject: '12345',
  isVerified: true, verificationToken: null, verificationExpires: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.resetAllMocks();
  address = `192.0.2.${addressCounter++}`;
  (config as { googleClientId: string | null }).googleClientId = 'test-client.apps.googleusercontent.com';
  vi.mocked(createGoogleChallenge).mockResolvedValue({ cookie: 'browser-cookie', nonce: 'public-nonce' });
  vi.mocked(consumeGoogleChallenge).mockResolvedValue('nonce-hash');
  vi.mocked(verifyGoogleCredential).mockResolvedValue({ subject: '12345', email: 'coder@gmail.com', name: 'Coder', authoritativeEmail: true });
  vi.mocked(resolveGoogleUser).mockResolvedValue(googleUser);
  vi.mocked(prisma.refreshToken.create).mockResolvedValue({
    id: 'refresh', userId: googleUser.id, tokenHash: 'token-hash', expiresAt: new Date(), revoked: false, createdAt: new Date(),
  });
});

describe('Google sign-in routes', () => {
  it('publishes only the public client ID and disables caching', async () => {
    const response = await request(app).get('/api/auth/google/config');
    expect(response.body).toEqual({ success: true, data: { clientId: config.googleClientId } });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('gracefully disables Google when there is no client ID', async () => {
    (config as { googleClientId: string | null }).googleClientId = null;
    expect((await request(app).get('/api/auth/google/config')).body.data.clientId).toBeNull();
    expect((await post('/google/challenge').send({})).status).toBe(503);
    expect((await post('/google').send({ credential: 'token' })).status).toBe(503);
    expect(createGoogleChallenge).not.toHaveBeenCalled();
  });

  it.each(['/google/challenge', '/google'])('refuses absent, null and untrusted origins on %s', async path => {
    for (const untrusted of [undefined, 'null', 'https://attacker.example']) {
      let req = request(app).post(`/api/auth${path}`);
      if (untrusted) req = req.set('Origin', untrusted);
      const response = await req.send({ credential: 'token' });
      expect(response.status).toBe(403);
    }
    expect(createGoogleChallenge).not.toHaveBeenCalled();
    expect(consumeGoogleChallenge).not.toHaveBeenCalled();
  });

  it('refuses form submissions to prevent login CSRF', async () => {
    expect((await post('/google').type('form').send({ credential: 'token' })).status).toBe(415);
    expect(consumeGoogleChallenge).not.toHaveBeenCalled();
  });

  it('returns a nonce while placing the browser secret only in an httpOnly cookie', async () => {
    const response = await post('/google/challenge').set('Cookie', 'googleSignInChallenge=previous').send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { nonce: 'public-nonce' } });
    expect(createGoogleChallenge).toHaveBeenCalledWith('previous');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('Path=/api/auth/google');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=300');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('creates the existing session envelope and never returns Google credentials, identity secrets, or refresh tokens', async () => {
    const response = await post('/google').set('Cookie', 'googleSignInChallenge=browser-cookie').send({ credential: 'google-token' });
    expect(response.status).toBe(200);
    expect(consumeGoogleChallenge).toHaveBeenCalledWith('browser-cookie');
    expect(verifyGoogleCredential).toHaveBeenCalledWith('google-token', 'nonce-hash');
    expect(response.body.data.user).toEqual({ id: 'user', email: 'coder@gmail.com', name: 'Coder' });
    expect(jwt.verify(response.body.data.accessToken, config.jwt.accessSecret)).toMatchObject({ userId: 'user' });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.find(cookie => cookie.startsWith('googleSignInChallenge='))).toContain('Expires=Thu, 01 Jan 1970');
    const refreshCookie = cookies.find(cookie => cookie.startsWith('refreshToken='))!;
    expect(refreshCookie).toContain('HttpOnly');
    const refreshToken = decodeURIComponent(refreshCookie.split(';')[0].slice('refreshToken='.length));
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'user', tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
    }) });
    expect(response.body.data).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(response.body)).not.toContain('google-token');
  });

  it('rejects a missing, expired or replayed challenge before verifying any Google token', async () => {
    vi.mocked(consumeGoogleChallenge).mockResolvedValue(null);
    const response = await post('/google').send({ credential: 'token' });
    expect(response.status).toBe(401);
    expect(verifyGoogleCredential).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('consumes the challenge even for a malformed credential request', async () => {
    const response = await post('/google').set('Cookie', 'googleSignInChallenge=browser-cookie').send({});
    expect(response.status).toBe(400);
    expect(consumeGoogleChallenge).toHaveBeenCalled();
    expect(verifyGoogleCredential).not.toHaveBeenCalled();
  });

  it('returns safe verification errors and refuses account conflicts without creating sessions', async () => {
    vi.mocked(verifyGoogleCredential).mockRejectedValueOnce(new GoogleSignInError('Google sign-in could not be verified.'));
    expect((await post('/google').send({ credential: 'token' })).status).toBe(401);
    vi.mocked(resolveGoogleUser).mockRejectedValueOnce(new GoogleSignInError('Sign in with your email and password.', 409));
    const conflict = await post('/google').send({ credential: 'token' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toContain('email and password');
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('does not leak database errors to the browser', async () => {
    vi.mocked(resolveGoogleUser).mockRejectedValue(new Error('Database secret detail'));
    const response = await post('/google').send({ credential: 'token' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('Database secret detail');
  });

  it('does not create a session when a new third-party email requires local verification', async () => {
    vi.mocked(verifyGoogleCredential).mockResolvedValue({
      subject: '12345', email: 'coder@external.com', name: 'Coder', authoritativeEmail: false,
    });
    vi.mocked(resolveGoogleUser).mockRejectedValue(new GoogleSignInError('Use email and password to create and verify an account for this address.', 409));
    const response = await post('/google').send({ credential: 'token' });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('create and verify an account');
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(response.body).not.toHaveProperty('data.accessToken');
  });

  it('rejects password login for a Google-only user cleanly', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(googleUser);
    const response = await post('/login').send({ email: 'coder@gmail.com', password: 'anything' });
    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Invalid email or password');
  });

  it('rate limits failed Google sign-ins separately from password sign-in', async () => {
    vi.mocked(consumeGoogleChallenge).mockResolvedValue(null);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await post('/google').send({ credential: 'token' })).status).toBe(401);
    }
    expect((await post('/google').send({ credential: 'token' })).status).toBe(429);
    expect(consumeGoogleChallenge).toHaveBeenCalledTimes(10);
  });
});
