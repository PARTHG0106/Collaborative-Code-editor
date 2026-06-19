import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';

// Mock Prisma client
vi.mock('../lib/prisma.js', () => {
  const mockPrisma = {
    workspace: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    workspaceMember: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb({
      workspace: {
        create: vi.fn(),
      },
      workspaceMember: {
        create: vi.fn(),
      },
    })),
  };
  return {
    default: mockPrisma,
    prisma: mockPrisma,
  };
});

const app = createApp();

// Setup auth helper
const mockUser = {
  id: 'user-id-123',
  email: 'test@example.com',
  name: 'Test User',
};

const accessToken = jwt.sign(
  { userId: mockUser.id, email: mockUser.email, name: mockUser.name },
  config.jwt.accessSecret
);

describe('Workspace Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/workspaces', () => {
    it('should list all workspaces user is a member of', async () => {
      const mockWorkspaceMemberships = [
        {
          id: 'membership-1',
          role: 'OWNER',
          joinedAt: new Date().toISOString(),
          workspace: {
            id: 'ws-1',
            name: 'Workspace One',
            description: 'First test workspace',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            _count: { members: 2 },
          },
        },
      ];

      vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue(mockWorkspaceMemberships as any);

      const response = await request(app)
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe('ws-1');
      expect(response.body.data[0].role).toBe('OWNER');
      expect(response.body.data[0].memberCount).toBe(2);
    });

    it('should return 401 if unauthorized', async () => {
      const response = await request(app).get('/api/workspaces');
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/workspaces', () => {
    it('should create workspace and return 201 with role OWNER', async () => {
      const workspaceData = {
        name: 'New Code Project',
        description: 'Collaborative development area',
      };

      const mockWorkspace = {
        id: 'ws-123',
        name: workspaceData.name,
        description: workspaceData.description,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Mock the transaction flow
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        const tx = {
          workspace: {
            create: vi.fn().mockResolvedValue(mockWorkspace),
          },
          workspaceMember: {
            create: vi.fn().mockResolvedValue({ id: 'member-123' }),
          },
        };
        return callback(tx);
      });

      const response = await request(app)
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(workspaceData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe('ws-123');
      expect(response.body.data.role).toBe('OWNER');
    });

    it('should fail validation with 400 if workspace name is missing', async () => {
      const response = await request(app)
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ description: 'No name' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('Validation failed');
    });
  });

  describe('GET /api/workspaces/:id', () => {
    it('should return workspace details and members if user is a member', async () => {
      const mockWorkspace = {
        id: 'ws-123',
        name: 'Workspace One',
        description: 'Test',
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [
          {
            id: 'membership-123',
            role: 'OWNER',
            joinedAt: new Date(),
            user: {
              id: 'user-id-123',
              name: 'Test User',
              email: 'test@example.com',
            },
          },
        ],
      };

      // Mock membership check
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'membership-123',
        workspaceId: 'ws-123',
        userId: 'user-id-123',
        role: 'OWNER',
      } as any);

      // Mock workspace fetch
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue(mockWorkspace as any);

      const response = await request(app)
        .get('/api/workspaces/ws-123')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('Workspace One');
      expect(response.body.data.currentUserRole).toBe('OWNER');
      expect(response.body.data.members).toHaveLength(1);
    });

    it('should return 403 if user is not a member of the workspace', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/workspaces/ws-not-member')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('not a member');
    });
  });

  describe('PATCH /api/workspaces/:id', () => {
    it('should allow updates for OWNER or EDITOR role', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-123',
        role: 'EDITOR',
        workspaceId: 'ws-123',
      } as any);

      vi.mocked(prisma.workspace.update).mockResolvedValue({
        id: 'ws-123',
        name: 'Updated Name',
        description: 'New Description',
      } as any);

      const response = await request(app)
        .patch('/api/workspaces/ws-123')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Updated Name', description: 'New Description' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('Updated Name');
    });

    it('should reject updates (403) for VIEWER role', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-123',
        role: 'VIEWER',
        workspaceId: 'ws-123',
      } as any);

      const response = await request(app)
        .patch('/api/workspaces/ws-123')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Hack Name' });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });
  });

  describe('DELETE /api/workspaces/:id', () => {
    it('should allow deletion for OWNER role', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-123',
        role: 'OWNER',
        workspaceId: 'ws-123',
      } as any);

      const response = await request(app)
        .delete('/api/workspaces/ws-123')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(prisma.workspace.delete).toHaveBeenCalledWith({
        where: { id: 'ws-123' },
      });
    });

    it('should reject deletion for EDITOR role', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'member-123',
        role: 'EDITOR',
        workspaceId: 'ws-123',
      } as any);

      const response = await request(app)
        .delete('/api/workspaces/ws-123')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/workspaces/:id/members', () => {
    it('should allow OWNER to invite members by email', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'caller-member-123',
        role: 'OWNER',
        workspaceId: 'ws-123',
      } as any);

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'invitee-user-456',
        email: 'invitee@example.com',
        name: 'Invited Friend',
      } as any);

      // Verify not already member
      vi.mocked(prisma.workspaceMember.findUnique)
        .mockResolvedValueOnce({ role: 'OWNER' } as any) // first call is caller role middleware check
        .mockResolvedValueOnce(null); // second call is controller checking if user is already in workspace

      vi.mocked(prisma.workspaceMember.create).mockResolvedValue({
        id: 'new-membership-456',
        role: 'EDITOR',
        joinedAt: new Date(),
        user: { id: 'invitee-user-456', name: 'Invited Friend', email: 'invitee@example.com' },
      } as any);

      const response = await request(app)
        .post('/api/workspaces/ws-123/members')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: 'invitee@example.com', role: 'EDITOR' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('invitee@example.com');
      expect(response.body.data.role).toBe('EDITOR');
    });

    it('should fail (404) if invitee email is not registered', async () => {
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: 'caller-member-123',
        role: 'OWNER',
        workspaceId: 'ws-123',
      } as any);

      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/workspaces/ws-123/members')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: 'nonexistent@example.com', role: 'VIEWER' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });

  describe('DELETE /api/workspaces/:id/members/:userId', () => {
    it('should allow OWNER to remove a member', async () => {
      vi.mocked(prisma.workspaceMember.findUnique)
        .mockResolvedValueOnce({ role: 'OWNER', workspaceId: 'ws-123' } as any) // middleware check
        .mockResolvedValueOnce({ id: 'target-member', userId: 'user-456' } as any); // controller check

      const response = await request(app)
        .delete('/api/workspaces/ws-123/members/user-456')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.message).toContain('removed successfully');
    });

    it('should allow user to leave the workspace themselves (self removal)', async () => {
      vi.mocked(prisma.workspaceMember.findUnique)
        .mockResolvedValueOnce({ role: 'EDITOR', workspaceId: 'ws-123' } as any) // middleware check
        .mockResolvedValueOnce({ id: 'target-member', userId: 'user-id-123' } as any); // target exists

      const response = await request(app)
        .delete('/api/workspaces/ws-123/members/user-id-123') // caller leaves
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.message).toContain('Left workspace successfully');
    });

    it('should prevent OWNER from leaving workspace directly', async () => {
      vi.mocked(prisma.workspaceMember.findUnique)
        .mockResolvedValueOnce({ role: 'OWNER', workspaceId: 'ws-123' } as any);

      const response = await request(app)
        .delete('/api/workspaces/ws-123/members/user-id-123') // OWNER tries to delete self
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('OWNER cannot leave');
    });
  });
});
