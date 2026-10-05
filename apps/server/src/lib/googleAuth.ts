import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import prisma from './prisma.js';
import { config } from '../config/index.js';

const googleClient = new OAuth2Client();
export const GOOGLE_CHALLENGE_TTL = 5 * 60 * 1000;
export const GOOGLE_CHALLENGE_COOKIE = 'googleSignInChallenge';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class GoogleSignInError extends Error {
  constructor(message: string, public statusCode = 401) {
    super(message);
  }
}

export type GoogleIdentity = {
  subject: string;
  email: string;
  name: string;
  authoritativeEmail: boolean;
};

/** The library verifies the signature, issuer, audience and token lifetime. */
export async function verifyGoogleCredential(credential: string, nonceHash: string): Promise<GoogleIdentity> {
  if (!config.googleClientId) throw new GoogleSignInError('Google sign-in is not configured.', 503);
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    const payload = ticket.getPayload();
    const nonce = (payload as (typeof payload & { nonce?: unknown }))?.nonce;
    const email = payload?.email?.trim().toLowerCase();
    if (!payload || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
      || payload.aud !== config.googleClientId || (payload.azp && payload.azp !== config.googleClientId)
      || !Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
      || payload.email_verified !== true || !z.string().email().max(254).safeParse(email).success
      || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonceHash)
      || !timingSafeEqual(Buffer.from(hash(nonce), 'hex'), Buffer.from(nonceHash, 'hex'))) {
      throw new Error('Invalid claims');
    }
    return {
      subject: payload.sub,
      email: email!,
      name: payload.name?.trim().slice(0, 80) || email!.split('@')[0],
      authoritativeEmail: email!.endsWith('@gmail.com') || (typeof payload.hd === 'string' && /^[a-z0-9.-]+$/i.test(payload.hd)),
    };
  } catch {
    // Google errors can contain the credential. Never log or return them.
    throw new GoogleSignInError('Google sign-in could not be verified. Please try again.');
  }
}

export async function createGoogleChallenge(previousCookie?: string) {
  const cookie = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  await prisma.googleAuthChallenge.deleteMany({
    where: { OR: [
      { expiresAt: { lte: new Date() } },
      ...(typeof previousCookie === 'string' ? [{ tokenHash: hash(previousCookie) }] : []),
    ] },
  });
  await prisma.googleAuthChallenge.create({
    data: { tokenHash: hash(cookie), nonceHash: hash(nonce), expiresAt: new Date(Date.now() + GOOGLE_CHALLENGE_TTL) },
  });
  return { cookie, nonce };
}

/** Delete before verifying or logging in, so replay fails across all servers. */
export async function consumeGoogleChallenge(cookie?: string): Promise<string | null> {
  if (typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
  const tokenHash = hash(cookie);
  const challenge = await prisma.googleAuthChallenge.findUnique({ where: { tokenHash } });
  if (!challenge) return null;
  const { count } = await prisma.googleAuthChallenge.deleteMany({ where: { tokenHash } });
  if (count !== 1 || challenge.expiresAt.getTime() <= Date.now()) return null;
  return challenge.nonceHash;
}

/** Resolve by immutable Google subject, with conservative email-only linking. */
export async function resolveGoogleUser(identity: GoogleIdentity) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const linked = await tx.user.findUnique({ where: { googleSubject: identity.subject } });
        if (linked) {
          if (!linked.isVerified) throw new GoogleSignInError('Verify your existing account before signing in with Google.', 409);
          // Google email changes must not silently change local ownership or
          // merge accounts. The established immutable subject wins.
          return linked;
        }

        const matches = await tx.user.findMany({
          where: { email: { equals: identity.email, mode: 'insensitive' } }, take: 2,
        });
        if (matches.length > 1) throw new GoogleSignInError('Use email and password to sign in to your existing account.', 409);
        const existing = matches[0];
        if (existing) {
          if (existing.googleSubject && existing.googleSubject !== identity.subject) {
            throw new GoogleSignInError('This email belongs to a different Google account. Use your original sign-in method.', 409);
          }
          if (!existing.isVerified) {
            // Never validate an account while retaining a password that an
            // attacker could have chosen in an unfinished registration.
            throw new GoogleSignInError('An account with this email is awaiting verification. Sign in with your password and verify it before using Google.', 409);
          }
          if (!identity.authoritativeEmail) {
            throw new GoogleSignInError('An account already uses this email. Sign in with your email and password.', 409);
          }
          const result = await tx.user.updateMany({
            where: { id: existing.id, googleSubject: null, isVerified: true },
            data: { googleSubject: identity.subject },
          });
          if (result.count !== 1) throw new GoogleSignInError('Your account changed during sign-in. Please try again.', 409);
          return existing;
        }

        if (!identity.authoritativeEmail) {
          // Google may have verified a third-party address years ago. It is
          // not proof of current ownership for email-addressed invitations.
          throw new GoogleSignInError('Use email and password to create and verify an account for this address.', 409);
        }
        return tx.user.create({ data: {
          email: identity.email, name: identity.name, googleSubject: identity.subject,
          passwordHash: null, isVerified: true,
        } });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // A simultaneous create/link either completed the same identity or
      // established a conflict. Re-read it, without ever overwriting a link.
      if ((code === 'P2002' || code === 'P2034') && attempt < 2) continue;
      if (code === 'P2002' || code === 'P2034') {
        throw new GoogleSignInError('Your account changed during sign-in. Please try again.', 409);
      }
      throw error;
    }
  }
  throw new GoogleSignInError('Please try signing in again.', 409);
}
