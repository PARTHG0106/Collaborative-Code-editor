import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createHash, randomInt, randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { config } from '../config/index.js';
import { requireAuth, AuthRequest, TokenPayload } from '../middleware/auth.js';
import { sendEmail } from '../utils/mailer.js';
import { originAllowlist } from '../lib/corsOrigins.js';
import {
  createGoogleChallenge, consumeGoogleChallenge, verifyGoogleCredential, resolveGoogleUser,
  GoogleSignInError, GOOGLE_CHALLENGE_COOKIE, GOOGLE_CHALLENGE_TTL,
} from '../lib/googleAuth.js';

const router = Router();

const limiterResponse = (message: string) => ({
  success: false,
  error: { message, statusCode: 429 },
});

/**
 * Credential stuffing protection. Successful logins are not counted, so a
 * legitimate user who keeps signing in is never locked out by their own
 * traffic; only failures consume the budget.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limiterResponse('Too many sign-in attempts. Please try again in 15 minutes.'),
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limiterResponse('Too many accounts created from this network. Please try again later.'),
});

/** Anything that causes us to send mail needs a tighter budget than the rest. */
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limiterResponse('Too many verification emails requested. Please try again in an hour.'),
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limiterResponse('Too many verification attempts. Please try again in 15 minutes.'),
});

const googleChallengeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: limiterResponse('Too many Google sign-in attempts. Please try again in 15 minutes.'),
});

const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: limiterResponse('Too many Google sign-in attempts. Please try again in 15 minutes.'),
});

const googleCookieOptions = {
  httpOnly: true, secure: config.isProduction,
  sameSite: config.isProduction ? 'none' as const : 'lax' as const,
  path: '/api/auth/google',
};

function requireGoogleOrigin(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  // CORS only controls reading responses. Refuse disallowed writes too,
  // including form submissions and requests with an absent/null Origin.
  if (!req.headers.origin || !originAllowlist.isAllowed(req.headers.origin)) {
    return res.status(403).json({ success: false, error: { message: 'Sign-in origin is not allowed.', statusCode: 403 } });
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ success: false, error: { message: 'Sign-in requires a JSON request.', statusCode: 415 } });
  }
  if (!config.googleClientId) {
    return res.status(503).json({ success: false, error: { message: 'Google sign-in is not configured.', statusCode: 503 } });
  }
  next();
}

const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-account wrong-code counter, layered under the IP limiter above so that a
 * distributed attacker cannot simply rotate addresses to brute force a single
 * account's six digit code.
 */
const verifyAttempts = new Map<string, { count: number; firstAt: number }>();

function tooManyVerifyAttempts(email: string): boolean {
  const entry = verifyAttempts.get(email);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > VERIFY_WINDOW_MS) {
    verifyAttempts.delete(email);
    return false;
  }
  return entry.count >= MAX_VERIFY_ATTEMPTS;
}

function recordVerifyFailure(email: string): void {
  const entry = verifyAttempts.get(email);
  if (!entry || Date.now() - entry.firstAt > VERIFY_WINDOW_MS) {
    verifyAttempts.set(email, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

/**
 * Six digit verification code from a cryptographically secure source.
 * Math.random() is not suitable here: its output is predictable enough that a
 * code can be guessed rather than intercepted.
 */
function generateVerificationCode(): string {
  return String(randomInt(100000, 1000000));
}

// Validation Schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  name: z.string().min(2, 'Name must be at least 2 characters long'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const verifySchema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().length(6, 'Verification code must be exactly 6 digits'),
});

const resendSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const refreshSchema = z.object({
  refreshToken: z.string().optional(),
});

// Helper: Generate Access Token
function generateAccessToken(user: { id: string; email: string; name: string }): string {
  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    name: user.name,
  };
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry as any,
  });
}

// Helper: Generate Refresh Token
function generateRefreshToken(userId: string): string {
  return jwt.sign({ userId }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry as any,
    jwtid: randomUUID(),
  });
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Helper: Set Refresh Token Cookie
 *
 * This cookie is the only place the refresh token is handed to a browser. It is
 * deliberately not echoed in any response body: a body copy is what allowed the
 * frontend to mirror it into localStorage, where any XSS could read it.
 */
function setRefreshTokenCookie(res: Response, token: string) {
  // Parse expiry duration to milliseconds (defaults to 7 days if parsing fails)
  let maxAge = 7 * 24 * 60 * 60 * 1000;
  const match = config.jwt.refreshExpiry.match(/^(\d+)([dhm])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 'd') maxAge = value * 24 * 60 * 60 * 1000;
    else if (unit === 'h') maxAge = value * 60 * 60 * 1000;
    else if (unit === 'm') maxAge = value * 60 * 1000;
  }

  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? 'none' : 'lax',
    maxAge,
  });
}

router.get('/google/config', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: { clientId: config.googleClientId } });
});

router.post('/google/challenge', requireGoogleOrigin, googleChallengeLimiter, async (req: Request, res: Response) => {
  try {
    const { cookie, nonce } = await createGoogleChallenge(req.cookies?.[GOOGLE_CHALLENGE_COOKIE]);
    res.cookie(GOOGLE_CHALLENGE_COOKIE, cookie, { ...googleCookieOptions, maxAge: GOOGLE_CHALLENGE_TTL });
    res.json({ success: true, data: { nonce } });
  } catch {
    res.status(500).json({ success: false, error: { message: 'Could not start Google sign-in. Please try again.', statusCode: 500 } });
  }
});

router.post('/google', requireGoogleOrigin, googleLoginLimiter, async (req: Request, res: Response) => {
  res.clearCookie(GOOGLE_CHALLENGE_COOKIE, googleCookieOptions);
  try {
    const nonceHash = await consumeGoogleChallenge(req.cookies?.[GOOGLE_CHALLENGE_COOKIE]);
    if (!nonceHash) throw new GoogleSignInError('Google sign-in expired. Please try again.');
    const input = z.object({ credential: z.string().min(1).max(16384) }).safeParse(req.body);
    if (!input.success) throw new GoogleSignInError('A valid Google credential is required.', 400);
    const identity = await verifyGoogleCredential(input.data.credential, nonceHash);
    const user = await resolveGoogleUser(identity);
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);
    const decoded = jwt.decode(refreshToken) as { exp: number };
    await prisma.refreshToken.create({ data: {
      tokenHash: hashRefreshToken(refreshToken), userId: user.id, expiresAt: new Date(decoded.exp * 1000),
    } });
    setRefreshTokenCookie(res, refreshToken);
    res.json({ success: true, data: {
      accessToken, user: { id: user.id, email: user.email, name: user.name },
    } });
  } catch (error) {
    const statusCode = error instanceof GoogleSignInError ? error.statusCode : 500;
    const message = error instanceof GoogleSignInError ? error.message : 'Google sign-in could not complete. Please try again.';
    res.status(statusCode).json({ success: false, error: { message, statusCode } });
  }
});

/**
 * POST /api/auth/register
 * Registers a new user.
 */
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'A user with this email address already exists',
            statusCode: 400,
          },
        });
      }

      // Existing unverified user: update their details, generate a new code, and send it
      const passwordHash = await bcrypt.hash(password, 12);
      const verificationToken = generateVerificationCode();
      const verificationExpires = new Date(Date.now() + 3600000); // 1 hour

      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          passwordHash,
          name,
          verificationToken,
          verificationExpires,
        },
        select: {
          id: true,
          email: true,
          name: true,
          isVerified: true,
          createdAt: true,
        },
      });

      sendEmail({
        to: email,
        subject: 'Verify your Collaborative Code Editor account',
        text: `Hello ${name},\n\nWelcome to Collaborative Code Editor! To verify your account, please enter the following 6-digit code on the verification page:\n\n${verificationToken}\n\nThis code will expire in 1 hour.\n\nHappy Coding!\nThe Collab Team`,
      }).catch((err) => {
        console.error('Failed to send registration verification email:', err);
      });

      return res.status(201).json({
        success: true,
        data: {
          user: updatedUser,
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Generate 6-digit verification code
    const verificationToken = generateVerificationCode();
    const verificationExpires = new Date(Date.now() + 3600000); // 1 hour

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        isVerified: false,
        verificationToken,
        verificationExpires,
      },
      select: {
        id: true,
        email: true,
        name: true,
        isVerified: true,
        createdAt: true,
      },
    });

    // Send verification email asynchronously
    sendEmail({
      to: email,
      subject: 'Verify your Collaborative Code Editor account',
      text: `Hello ${name},\n\nWelcome to Collaborative Code Editor! To verify your account, please enter the following 6-digit code on the verification page:\n\n${verificationToken}\n\nThis code will expire in 1 hour.\n\nHappy Coding!\nThe Collab Team`,
    }).catch((err) => {
      console.error('Failed to send registration verification email:', err);
    });

    res.status(201).json({
      success: true,
      data: {
        user,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during registration',
        statusCode: 500,
      },
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticates user and returns an access token. The refresh token is set as
 * an httpOnly cookie only.
 */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid email or password',
          statusCode: 401,
        },
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid email or password',
          statusCode: 401,
        },
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        error: {
          message: 'Email address is not verified',
          statusCode: 403,
          code: 'EMAIL_NOT_VERIFIED',
          email: user.email,
        },
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);

    // Calculate refresh token expiry
    const expiresAt = new Date();
    let days = 7;
    const match = config.jwt.refreshExpiry.match(/^(\d+)d$/);
    if (match) days = parseInt(match[1], 10);
    expiresAt.setDate(expiresAt.getDate() + days);

    // Save refresh token to database
    await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(refreshToken),
        userId: user.id,
        expiresAt,
      },
    });

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during login',
        statusCode: 500,
      },
    });
  }
});

/**
 * POST /api/auth/refresh
 * Uses the refresh token cookie to issue a new access token and rotate the
 * refresh token. The rotated token is returned as a cookie, never in the body.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken: bodyToken } = refreshSchema.parse(req.body ?? {});
    const token = req.cookies?.refreshToken || bodyToken;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Refresh token is required',
          statusCode: 400,
        },
      });
    }

    // Verify token structure
    let decoded: { userId: string };
    try {
      decoded = jwt.verify(token, config.jwt.refreshSecret) as { userId: string };
    } catch {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid refresh token',
          statusCode: 401,
        },
      });
    }

    // Find and validate token in database
    const dbToken = await prisma.refreshToken.findFirst({
      where: { tokenHash: hashRefreshToken(token) },
      include: { user: true },
    });

    if (!dbToken || dbToken.revoked || dbToken.expiresAt < new Date()) {
      // Security measure: if token is found but revoked, someone might have compromised it.
      // In a full production app, you might revoke all tokens for this user.
      if (dbToken && dbToken.revoked) {
        await prisma.refreshToken.deleteMany({
          where: { userId: decoded.userId },
        });
      }
      return res.status(401).json({
        success: false,
        error: {
          message: 'Refresh token expired or revoked',
          statusCode: 401,
        },
      });
    }

    // Token is valid. Issue new tokens (rotation)
    const accessToken = generateAccessToken(dbToken.user);
    const newRefreshToken = generateRefreshToken(dbToken.user.id);

    // Calculate new expiry
    const expiresAt = new Date();
    let days = 7;
    const match = config.jwt.refreshExpiry.match(/^(\d+)d$/);
    if (match) days = parseInt(match[1], 10);
    expiresAt.setDate(expiresAt.getDate() + days);

    // Delete old refresh token & save new one (atomic transaction)
    await prisma.$transaction([
      prisma.refreshToken.delete({ where: { id: dbToken.id } }),
      prisma.refreshToken.create({
        data: {
          tokenHash: hashRefreshToken(newRefreshToken),
          userId: dbToken.user.id,
          expiresAt,
        },
      }),
    ]);

    setRefreshTokenCookie(res, newRefreshToken);

    res.json({
      success: true,
      data: {
        accessToken,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during refresh',
        statusCode: 500,
      },
    });
  }
});

/**
 * POST /api/auth/logout
 * Revokes refresh token and clears client cookies.
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (token) {
      // Delete token from database (revoke it)
      await prisma.refreshToken.deleteMany({
        where: { tokenHash: hashRefreshToken(token) },
      });
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: config.isProduction ? 'none' : 'lax',
    });

    res.json({
      success: true,
      data: {
        message: 'Successfully logged out',
      },
    });
  } catch {
    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during logout',
        statusCode: 500,
      },
    });
  }
});

/**
 * GET /api/auth/me
 * Retrieves current authenticated user profile.
 */
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // req.user is guaranteed to be set by requireAuth middleware
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'User not found',
          statusCode: 404,
        },
      });
    }

    res.json({
      success: true,
      data: {
        user,
      },
    });
  } catch {
    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error retrieving user profile',
        statusCode: 500,
      },
    });
  }
});

/**
 * POST /api/auth/verify
 * Verifies email with 6-digit code and logs user in.
 */
router.post('/verify', verifyLimiter, async (req: Request, res: Response) => {
  try {
    const { email, code } = verifySchema.parse(req.body);

    if (tooManyVerifyAttempts(email)) {
      return res.status(429).json({
        success: false,
        error: {
          message: 'Too many incorrect codes. Please request a new code and try again shortly.',
          statusCode: 429,
        },
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'User not found',
          statusCode: 400,
        },
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Email address is already verified',
          statusCode: 400,
        },
      });
    }

    if (user.verificationToken !== code) {
      recordVerifyFailure(email);
      return res.status(400).json({
        success: false,
        error: {
          message: 'Invalid verification code',
          statusCode: 400,
        },
      });
    }

    if (user.verificationExpires && user.verificationExpires < new Date()) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Verification code has expired',
          statusCode: 400,
        },
      });
    }

    // Correct code: clear the failure counter for this address.
    verifyAttempts.delete(email);

    // Mark as verified
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        verificationToken: null,
        verificationExpires: null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    // Generate tokens to log them in directly
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);

    // Calculate refresh token expiry
    const expiresAt = new Date();
    let days = 7;
    const match = config.jwt.refreshExpiry.match(/^(\d+)d$/);
    if (match) days = parseInt(match[1], 10);
    expiresAt.setDate(expiresAt.getDate() + days);

    // Save refresh token to database
    await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(refreshToken),
        userId: user.id,
        expiresAt,
      },
    });

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        accessToken,
        user: updatedUser,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during verification',
        statusCode: 500,
      },
    });
  }
});

/**
 * POST /api/auth/resend-verification
 * Generates and resends a new verification code.
 */
router.post('/resend-verification', emailLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = resendSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'User not found',
          statusCode: 400,
        },
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Email address is already verified',
          statusCode: 400,
        },
      });
    }

    // Generate new 6-digit code
    const verificationToken = generateVerificationCode();
    const verificationExpires = new Date(Date.now() + 3600000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationToken,
        verificationExpires,
      },
    });

    // A fresh code invalidates any accumulated wrong guesses.
    verifyAttempts.delete(email);

    // Send code
    sendEmail({
      to: email,
      subject: 'Verify your Collaborative Code Editor account',
      text: `Hello ${user.name},\n\nYour new verification code is:\n\n${verificationToken}\n\nThis code will expire in 1 hour.\n\nHappy Coding!\nThe Collab Team`,
    }).catch((err) => {
      console.error('Failed to send resend-verification email:', err);
    });

    res.json({
      success: true,
      data: {
        message: 'Verification code resent successfully',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          statusCode: 400,
          details: error.errors,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during code resend',
        statusCode: 500,
      },
    });
  }
});

export default router;
