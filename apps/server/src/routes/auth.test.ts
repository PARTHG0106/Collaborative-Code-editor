import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';
import { sendEmail } from '../utils/mailer.js';

vi.mock('../utils/mailer.js', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));

// Mock the entire prisma client module
vi.mock('../lib/prisma.js', () => {
  return {
    default: {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      refreshToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn((cb) => cb),
    },
  };
});

const app = createApp();

describe('Auth Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendEmail).mockResolvedValue(true);
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      };

      const mockDbUser = {
        id: 'user-id-123',
        email: userData.email,
        name: userData.name,
        createdAt: new Date().toISOString(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.create).mockResolvedValue(mockDbUser as any);

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user.email).toBe(userData.email);
      expect(response.body.data.user.name).toBe(userData.name);
      expect(response.body.data.user.id).toBe('user-id-123');
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('should fail registration if email already exists and is verified', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'existing-id', isVerified: true } as any);

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('already exists');
    });

    it('should succeed registration by updating user if email already exists but is unverified', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      };

      const mockDbUser = {
        id: 'existing-id',
        email: 'test@example.com',
        name: 'Test User',
        isVerified: false,
        createdAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'existing-id', isVerified: false } as any);
      vi.mocked(prisma.user.update).mockResolvedValue(mockDbUser as any);

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user.email).toBe(userData.email);
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('should fail registration if validation fails', async () => {
      const userData = {
        email: 'invalid-email',
        password: '123', // less than 6 chars
        name: 'a', // less than 2 chars
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe('Validation failed');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login successfully and return access token and set cookie', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'password123',
      };

      const passwordHash = await bcrypt.hash(loginData.password, 6);
      const mockUser = {
        id: 'user-id-123',
        email: loginData.email,
        name: 'Test User',
        passwordHash,
        isVerified: true,
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.user.email).toBe(loginData.email);

      // Check cookie headers
      const cookies = response.headers['set-cookie'];
      const cookieArray = Array.isArray(cookies) ? cookies : typeof cookies === 'string' ? [cookies] : [];
      expect(cookieArray.some((cookie: string) => cookie.includes('refreshToken'))).toBe(true);
      const refreshCookie = cookieArray.find((cookie: string) => cookie.startsWith('refreshToken='))!;
      const refreshToken = decodeURIComponent(refreshCookie.split(';')[0].slice('refreshToken='.length));
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenHash: createHash('sha256').update(refreshToken).digest('hex') }),
      });
      expect(vi.mocked(prisma.refreshToken.create).mock.calls[0][0].data).not.toHaveProperty('token');
    });

    it('creates distinct refresh sessions for simultaneous logins by the same account', async () => {
      const loginData = { email: 'test@example.com', password: 'password123' };
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'user-id-123', email: loginData.email, name: 'Test User',
        passwordHash: await bcrypt.hash(loginData.password, 6), isVerified: true,
      } as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const responses = await Promise.all([
          request(app).post('/api/auth/login').send(loginData),
          request(app).post('/api/auth/login').send(loginData),
        ]);
        expect(responses.map(response => response.status)).toEqual([200, 200]);
        const hashes = vi.mocked(prisma.refreshToken.create).mock.calls.map(([args]) => args.data.tokenHash);
        expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
        expect(hashes[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(hashes[0]).not.toBe(hashes[1]);
      } finally { clock.mockRestore(); }
    });

    it('should fail login if password is incorrect', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      const passwordHash = await bcrypt.hash('password123', 6);
      const mockUser = {
        id: 'user-id-123',
        email: loginData.email,
        name: 'Test User',
        passwordHash,
        isVerified: true,
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe('Invalid email or password');
    });

    it('should fail login if user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@example.com', password: 'password123' });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should refresh access token using cookie', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        name: 'Test User',
      };

      const mockRefreshToken = jwt.sign({ userId: mockUser.id }, config.jwt.refreshSecret);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
        id: 'token-id',
        tokenHash: createHash('sha256').update(mockRefreshToken).digest('hex'),
        userId: mockUser.id,
        revoked: false,
        expiresAt,
        user: mockUser,
      } as any);

      vi.mocked(prisma.$transaction).mockResolvedValue([] as any);

      const response = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${mockRefreshToken}`]);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(prisma.refreshToken.findFirst).toHaveBeenCalledWith({
        where: { tokenHash: createHash('sha256').update(mockRefreshToken).digest('hex') },
        include: { user: true },
      });
      expect(vi.mocked(prisma.refreshToken.create).mock.calls[0][0].data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should reject refresh if token is expired or revoked', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
      };
      const mockRefreshToken = jwt.sign({ userId: mockUser.id }, config.jwt.refreshSecret);
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1); // yesterday

      vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
        id: 'token-id',
        tokenHash: createHash('sha256').update(mockRefreshToken).digest('hex'),
        userId: mockUser.id,
        revoked: false,
        expiresAt: expiredDate,
        user: mockUser,
      } as any);

      const response = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${mockRefreshToken}`]);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear refresh token cookie and delete from db', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', ['refreshToken=token-to-logout']);

      expect(response.status).toBe(200);
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { tokenHash: createHash('sha256').update('token-to-logout').digest('hex') },
      });
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return profile for authenticated requests', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        name: 'Test User',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const accessToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email, name: mockUser.name },
        config.jwt.accessSecret,
      );

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user.id).toBe(mockUser.id);
      expect(response.body.data.user.email).toBe(mockUser.email);
    });

    it('should return 401 if access token is invalid', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer invalid-token`);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Email Verification Flows', () => {
    it('should fail login if email is not verified', async () => {
      const loginData = {
        email: 'unverified@example.com',
        password: 'password123',
      };

      const passwordHash = await bcrypt.hash(loginData.password, 6);
      const mockUser = {
        id: 'user-id-123',
        email: loginData.email,
        name: 'Unverified User',
        passwordHash,
        isVerified: false,
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('should fail verify with invalid code', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        isVerified: false,
        verificationToken: '123456',
        verificationExpires: new Date(Date.now() + 3600000),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .post('/api/auth/verify')
        .send({ email: 'test@example.com', code: '000000' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('Invalid verification code');
    });

    it('should verify email successfully with valid code', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        isVerified: false,
        verificationToken: '123456',
        verificationExpires: new Date(Date.now() + 3600000),
      };

      const updatedUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        name: 'Test User',
        isVerified: true,
        createdAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const response = await request(app)
        .post('/api/auth/verify')
        .send({ email: 'test@example.com', code: '123456' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.user.email).toBe('test@example.com');
    });

    it('should resend verification code successfully', async () => {
      const mockUser = {
        id: 'user-id-123',
        email: 'test@example.com',
        name: 'Test User',
        isVerified: false,
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      const response = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toContain('resent successfully');
    });
  });
});
