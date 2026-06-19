import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';

vi.mock('../lib/prisma.js', () => {
  const mockPrisma = {
    fileVersion: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    fileSystemItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

describe('Workspace File Version Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/workspaces/:workspaceId/files/:fileId/versions', () => {
    it('should return 401 if unauthorized', async () => {
      const res = await request(app).get('/api/workspaces/ws-123/files/file-1/versions');
      expect(res.status).toBe(401);
    });

    it('should return 403 if not workspace member', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/workspaces/ws-123/files/file-1/versions')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(403);
    });

    it('should return versions successfully', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        workspaceId: 'ws-123',
        type: 'FILE',
      } as any);

      const mockVersions = [
        {
          id: 'v-1',
          version: 1,
          content: 'console.log("hello")',
          fileId: 'file-1',
          userId: 'user-123',
          createdAt: new Date(),
          user: { id: 'user-123', name: 'User One' },
        },
      ];

      vi.mocked(prisma.fileVersion.findMany).mockResolvedValue(mockVersions as any);

      const res = await request(app)
        .get('/api/workspaces/ws-123/files/file-1/versions')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].version).toBe(1);
    });
  });

  describe('POST /api/workspaces/:workspaceId/files/:fileId/versions', () => {
    it('should commit new version checkpoint', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        workspaceId: 'ws-123',
        type: 'FILE',
        content: 'new code content',
      } as any);

      vi.mocked(prisma.fileVersion.count).mockResolvedValue(0);

      vi.mocked(prisma.fileVersion.create).mockResolvedValue({
        id: 'v-2',
        version: 1,
        content: 'new code content',
        fileId: 'file-1',
        userId: 'user-123',
        createdAt: new Date(),
        user: { id: 'user-123', name: 'User One' },
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files/file-1/versions')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.content).toBe('new code content');
      expect(res.body.data.version).toBe(1);
    });
  });

  describe('POST /api/workspaces/:workspaceId/files/:fileId/versions/:versionId/restore', () => {
    it('should restore version content back to file', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        workspaceId: 'ws-123',
        type: 'FILE',
      } as any);

      vi.mocked(prisma.fileVersion.findUnique).mockResolvedValue({
        id: 'v-1',
        content: 'restored code content',
        fileId: 'file-1',
      } as any);

      vi.mocked(prisma.fileSystemItem.update).mockResolvedValue({
        id: 'file-1',
        content: 'restored code content',
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files/file-1/versions/v-1/restore')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.content).toBe('restored code content');
    });
  });
});
