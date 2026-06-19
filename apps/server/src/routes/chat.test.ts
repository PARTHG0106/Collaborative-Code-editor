import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';

vi.mock('../lib/prisma.js', () => {
  const mockPrisma = {
    chatMessage: {
      findMany: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
    },
  };
  return {
    default: mockPrisma,
    prisma: mockPrisma,
  };
});

const app = createApp();

const mockUser = {
  id: 'user-123',
  email: 'user@example.com',
  name: 'User One',
};

const accessToken = jwt.sign(
  { userId: mockUser.id, email: mockUser.email, name: mockUser.name },
  config.jwt.accessSecret
);

describe('Workspace Chat Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/workspaces/:workspaceId/chat', () => {
    it('should return 401 if unauthorized', async () => {
      const res = await request(app).get('/api/workspaces/ws-123/chat');
      expect(res.status).toBe(401);
    });

    it('should return 403 if not workspace member', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/workspaces/ws-123/chat')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('not a member');
    });

    it('should fetch chat history successfully', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        workspaceId: 'ws-123',
        userId: 'user-123',
        role: 'VIEWER',
        joinedAt: new Date(),
      } as any);

      const mockMessages = [
        {
          id: 'msg-1',
          message: 'Hello World',
          workspaceId: 'ws-123',
          userId: 'user-123',
          createdAt: new Date(),
          user: { id: 'user-123', name: 'User One' },
        },
      ];

      vi.mocked(prisma.chatMessage.findMany).mockResolvedValue(mockMessages as any);

      const res = await request(app)
        .get('/api/workspaces/ws-123/chat')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.messages).toHaveLength(1);
      expect(res.body.data.messages[0].message).toBe('Hello World');
    });
  });
});
