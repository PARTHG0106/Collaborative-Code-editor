import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';

vi.mock('../lib/prisma.js', () => {
  const mockPrisma = {
    fileSystemItem: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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

describe('File System Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/workspaces/:workspaceId/files', () => {
    it('should return 401 if unauthorized', async () => {
      const res = await request(app).get('/api/workspaces/ws-123/files');
      expect(res.status).toBe(401);
    });

    it('should return 403 if not workspace member', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('not a member');
    });

    it('should return flat list of files/folders in workspace', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        workspaceId: 'ws-123',
        userId: 'user-123',
        role: 'VIEWER',
        joinedAt: new Date(),
      } as any);

      const mockItems = [
        { id: 'item-1', name: 'src', type: 'FOLDER', parentId: null, workspaceId: 'ws-123' },
        { id: 'item-2', name: 'index.js', type: 'FILE', parentId: 'item-1', content: 'console.log("hello")', workspaceId: 'ws-123' },
      ];

      vi.mocked(prisma.fileSystemItem.findMany).mockResolvedValue(mockItems as any);

      const res = await request(app)
        .get('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].name).toBe('src');
    });
  });

  describe('POST /api/workspaces/:workspaceId/files', () => {
    it('should return 403 if viewer tries to create a file', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'VIEWER',
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'index.js', type: 'FILE' });

      expect(res.status).toBe(403);
    });

    it('should create file successfully if editor/owner', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.fileSystemItem.create).mockResolvedValue({
        id: 'item-new',
        name: 'index.js',
        type: 'FILE',
        content: '',
        parentId: null,
        workspaceId: 'ws-123',
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'index.js', type: 'FILE' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('index.js');
    });

    it('should fail if name contains slashes', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'src/index.js', type: 'FILE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('should fail if parentId belongs to another workspace or is a file', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'parent-id',
        type: 'FILE',
        workspaceId: 'ws-123',
      } as any);

      const res = await request(app)
        .post('/api/workspaces/ws-123/files')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'child.js', type: 'FILE', parentId: 'parent-id' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('not a folder');
    });
  });

  describe('PATCH /api/workspaces/:workspaceId/files/:id', () => {
    it('should rename file successfully', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        name: 'old.js',
        type: 'FILE',
        parentId: null,
        workspaceId: 'ws-123',
      } as any);

      vi.mocked(prisma.fileSystemItem.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.fileSystemItem.update).mockResolvedValue({
        id: 'file-1',
        name: 'new.js',
        type: 'FILE',
        content: 'old content',
        parentId: null,
        workspaceId: 'ws-123',
      } as any);

      const res = await request(app)
        .patch('/api/workspaces/ws-123/files/file-1')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'new.js' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('new.js');
    });

    it('should update file content successfully', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        name: 'old.js',
        type: 'FILE',
        parentId: null,
        workspaceId: 'ws-123',
      } as any);

      vi.mocked(prisma.fileSystemItem.update).mockResolvedValue({
        id: 'file-1',
        name: 'old.js',
        type: 'FILE',
        content: 'console.log("new content")',
        parentId: null,
        workspaceId: 'ws-123',
      } as any);

      const res = await request(app)
        .patch('/api/workspaces/ws-123/files/file-1')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ content: 'console.log("new content")' });

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('console.log("new content")');
    });
  });

  describe('DELETE /api/workspaces/:workspaceId/files/:id', () => {
    it('should delete file successfully', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-1',
        role: 'EDITOR',
      } as any);

      vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({
        id: 'file-1',
        workspaceId: 'ws-123',
      } as any);

      const res = await request(app)
        .delete('/api/workspaces/ws-123/files/file-1')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(prisma.fileSystemItem.delete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
    });
  });
});
