import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { config } from '../config/index.js';
import { requireAuth, AuthRequest, TokenPayload } from '../middleware/auth.js';

const router = Router();

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
  });
}

// Helper: Set Refresh Token Cookie
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
    sameSite: 'strict',
    maxAge,
  });
}

/**
 * POST /api/auth/register
 * Registers a new user.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'A user with this email address already exists',
          statusCode: 400,
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
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
 * Authenticates user and returns tokens.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
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
        token: refreshToken,
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
 * Uses refresh token to issue new access & refresh tokens (rotation).
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken: bodyToken } = refreshSchema.parse(req.body);
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
    const dbToken = await prisma.refreshToken.findUnique({
      where: { token },
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
          token: newRefreshToken,
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
    const token = req.cookies?.refreshToken || req.body.refreshToken;

    if (token) {
      // Delete token from database (revoke it)
      await prisma.refreshToken.deleteMany({
        where: { token },
      });
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'strict',
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

export default router;
