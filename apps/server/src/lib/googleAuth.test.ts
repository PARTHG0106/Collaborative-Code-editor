import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/index.js';
import { consumeGoogleChallenge, createGoogleChallenge, resolveGoogleUser, verifyGoogleCredential } from './googleAuth.js';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  googleAuthChallenge: { create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('./prisma.js', () => ({ default: db }));
vi.mock('../config/index.js', () => ({ config: { googleClientId: 'test-client.apps.googleusercontent.com' } }));

const clientId = 'test-client.apps.googleusercontent.com';
const nonce = 'a-browser-specific-random-nonce';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = { subject: '12345', email: 'coder@gmail.com', name: 'Google Name', authoritativeEmail: true };
const user = { id: 'existing', email: identity.email, name: 'Local Name', passwordHash: 'existing-password', googleSubject: null, isVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  (config as { googleClientId: string | null }).googleClientId = clientId;
  db.$transaction.mockImplementation(async callback => callback(db));
  db.user.findUnique.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([]);
  db.user.create.mockImplementation(async ({ data }) => ({ id: 'new-user', ...data }));
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.googleAuthChallenge.deleteMany.mockResolvedValue({ count: 1 });
});

describe('Google credential verification through google-auth-library', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let certSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    certSpy = vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, format: 'PEM',
    } as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>);
  });
  afterAll(() => certSpy.mockRestore());

  function credential(overrides: Record<string, unknown> = {}) {
    return jwt.sign({
      iss: 'https://accounts.google.com', aud: clientId, sub: identity.subject,
      email: 'Coder@gmail.com', email_verified: true, nonce, name: 'Google Name',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    }, keys.privateKey, { algorithm: 'RS256', keyid: 'test' });
  }

  it('verifies a signed Google token, normalizes email and identifies authoritative Gmail', async () => {
    await expect(verifyGoogleCredential(credential(), hash(nonce))).resolves.toEqual(identity);
    expect(certSpy).toHaveBeenCalled();
  });

  it.each([
    ['wrong audience', { aud: 'other-client.apps.googleusercontent.com' }],
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['future issue time', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['missing subject', { sub: undefined }],
    ['unverified email', { email_verified: false }],
    ['string verification flag', { email_verified: 'true' }],
    ['missing email', { email: undefined }],
    ['invalid email', { email: 'not-an-email' }],
    ['wrong nonce', { nonce: 'another-browser' }],
    ['missing nonce', { nonce: undefined }],
    ['wrong authorized party', { azp: 'other-client' }],
  ])('rejects %s without exposing credentials or provider errors', async (_label, claims) => {
    await expect(verifyGoogleCredential(credential(claims), hash(nonce)))
      .rejects.toThrow('Google sign-in could not be verified. Please try again.');
  });

  it('rejects an invalid signature even when all claims look valid', async () => {
    const token = credential();
    const pieces = token.split('.');
    pieces[2] = Buffer.alloc(256).toString('base64url');
    await expect(verifyGoogleCredential(pieces.join('.'), hash(nonce))).rejects.toThrow('could not be verified');
  });

  it('distinguishes Workspace emails from third-party Google-account emails', async () => {
    await expect(verifyGoogleCredential(credential({ email: 'coder@company.com', hd: 'company.com' }), hash(nonce)))
      .resolves.toMatchObject({ authoritativeEmail: true });
    await expect(verifyGoogleCredential(credential({ email: 'coder@external.com' }), hash(nonce)))
      .resolves.toMatchObject({ authoritativeEmail: false });
  });

  it('fails closed when no Google client is configured', async () => {
    (config as { googleClientId: string | null }).googleClientId = null;
    await expect(verifyGoogleCredential(credential(), hash(nonce))).rejects.toMatchObject({ statusCode: 503 });
    expect(certSpy).not.toHaveBeenCalled();
  });
});

describe('browser-bound Google challenges', () => {
  it('stores only random cookie/nonce hashes and replaces the previous browser challenge', async () => {
    const result = await createGoogleChallenge('previous-cookie');
    expect(result.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.cookie).not.toBe(result.nonce);
    expect(db.googleAuthChallenge.create).toHaveBeenCalledWith({ data: {
      tokenHash: hash(result.cookie), nonceHash: hash(result.nonce), expiresAt: expect.any(Date),
    } });
    expect(db.googleAuthChallenge.deleteMany).toHaveBeenCalledWith({ where: { OR: [
      { expiresAt: { lte: expect.any(Date) } }, { tokenHash: hash('previous-cookie') },
    ] } });
  });

  it('requires a browser cookie and atomically consumes valid challenges', async () => {
    db.googleAuthChallenge.findUnique.mockResolvedValue({ nonceHash: hash(nonce), expiresAt: new Date(Date.now() + 60000) });
    const cookie = 'x'.repeat(43);
    await expect(consumeGoogleChallenge(cookie)).resolves.toBe(hash(nonce));
    expect(db.googleAuthChallenge.deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hash(cookie) } });
    await expect(consumeGoogleChallenge()).resolves.toBeNull();
    await expect(consumeGoogleChallenge('malformed')).resolves.toBeNull();
    expect(db.googleAuthChallenge.findUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects expired, missing and concurrently consumed challenges', async () => {
    db.googleAuthChallenge.findUnique.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ nonceHash: hash(nonce), expiresAt: new Date(Date.now() - 1000) })
      .mockResolvedValueOnce({ nonceHash: hash(nonce), expiresAt: new Date(Date.now() + 60000) });
    await expect(consumeGoogleChallenge('x'.repeat(43))).resolves.toBeNull();
    await expect(consumeGoogleChallenge('x'.repeat(43))).resolves.toBeNull();
    db.googleAuthChallenge.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumeGoogleChallenge('x'.repeat(43))).resolves.toBeNull();
  });
});

describe('Google account ownership and linking', () => {
  it('creates verified Google-only users with no usable password', async () => {
    await expect(resolveGoogleUser(identity)).resolves.toMatchObject({ googleSubject: identity.subject, passwordHash: null, isVerified: true });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('requires local email verification before creating an account for a third-party Google address', async () => {
    await expect(resolveGoogleUser({ ...identity, email: 'coder@external.com', authoritativeEmail: false }))
      .rejects.toThrow('create and verify an account');
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('uses immutable subject for returning users and preserves their email/name if Google changes them', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, googleSubject: identity.subject, email: 'original@gmail.com' });
    await expect(resolveGoogleUser(identity)).resolves.toMatchObject({ email: 'original@gmail.com', name: 'Local Name' });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('allows an established subject even when its Google email is no longer authoritative', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, googleSubject: identity.subject });
    await expect(resolveGoogleUser({ ...identity, email: 'changed@external.com', authoritativeEmail: false }))
      .resolves.toMatchObject({ email: user.email });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('links authoritative email to a verified existing account without replacing its password, name or memberships', async () => {
    db.user.findMany.mockResolvedValue([user]);
    await expect(resolveGoogleUser(identity)).resolves.toEqual(user);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: user.id, googleSubject: null, isVerified: true }, data: { googleSubject: identity.subject },
    });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('refuses to verify an unfinished password registration through Google', async () => {
    db.user.findMany.mockResolvedValue([{ ...user, isVerified: false, passwordHash: 'attacker-chosen-password' }]);
    await expect(resolveGoogleUser(identity)).rejects.toThrow('awaiting verification');
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('refuses third-party email-only linking even when Google marks the address verified', async () => {
    db.user.findMany.mockResolvedValue([user]);
    await expect(resolveGoogleUser({ ...identity, authoritativeEmail: false })).rejects.toThrow('email and password');
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('does not replace a different Google identity already attached to the email', async () => {
    db.user.findMany.mockResolvedValue([{ ...user, googleSubject: 'different-subject' }]);
    await expect(resolveGoogleUser(identity)).rejects.toThrow('different Google account');
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('refuses ambiguous case-insensitive email matches', async () => {
    db.user.findMany.mockResolvedValue([user, { ...user, id: 'another', email: 'Coder@Gmail.com' }]);
    await expect(resolveGoogleUser(identity)).rejects.toThrow('email and password');
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it.each(['P2002', 'P2034'])('re-reads identity after a %s create/link race', async code => {
    db.$transaction.mockRejectedValueOnce({ code });
    db.user.findUnique.mockResolvedValue({ ...user, googleSubject: identity.subject });
    await expect(resolveGoogleUser(identity)).resolves.toMatchObject({ id: user.id });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and reports persistent conflicts without merging users', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(resolveGoogleUser(identity)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
});
