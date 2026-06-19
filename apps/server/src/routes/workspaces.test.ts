import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import prisma from '../lib/prisma.js';
import { WorkspaceRole } from '@prisma/client';

// Mock the entire prisma client module
vi.mock('../lib/prisma.js', () => {
  const mockClient = {
    user: {
      findUnique: vi.fn(),
    },
    workspace: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    workspaceMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    workspaceInvitation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb(mockClient)),
  };
  return {
    default: mockClient,
    prisma: mockClient,
  };
});

const app = createApp();

const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
};

const mockToken = jwt.sign(
  { userId: mockUser.id, email: mockUser.email, name: mockUser.name },
  config.jwt.accessSecret
);

describe('Workspace Routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET /api/workspaces', () => {
    it('should list all workspaces user is a member of', async () => {
      const mockMemberships = [
        {
          id: 'member-1',
          role: WorkspaceRole.OWNER,
          workspace: {
            id: 'ws-1',
            name: 'Workspace One',
            description: 'My first workspace',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      ];

      vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue(mockMemberships as any);

      const response = await request(app)
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${mockToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data[0].id).toBe('ws-1');
      expect(response.body.data[0].role).toBe(WorkspaceRole.OWNER);
      expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: mockUser.id } })
      );
    });

    it('should return 401 if token is invalid or missing', async () => {
      const response = await request(app).get('/api/workspaces');
      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/workspaces', () => {
    it('should create a workspace and make the user OWNER', async () => {
      const wsData = {
        name: 'New Workspace',
        description: 'New Description',
      };

      const mockWorkspace = {
        id: 'new-ws-123',
        name: wsData.name,
        description: wsData.description,
      };

      const mockMember = {
        id: 'member-id-123',
        role: WorkspaceRole.OWNER,
      };

      vi.mocked(prisma.workspace.create).mockResolvedValue(mockWorkspace as any);
      vi.mocked(prisma.workspaceMember.create).mockResolvedValue(mockMember as any);

      // Prisma transaction mock needs to yield results
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
        return fn(prisma);
      });

      const response = await request(app)
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${mockToken}`)
        .send(wsData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(mockWorkspace.id);
      expect(response.body.data.role).toBe(WorkspaceRole.OWNER);
    });
  });

  describe('GET /api/workspaces/:workspaceId', () => {
    it('should return workspace details if user is OWNER, EDITOR or VIEWER', async () => {
      const workspaceId = 'ws-123';
      const mockWorkspace = {
        id: workspaceId,
        name: 'Shared Workspace',
        description: 'Collaborative environment',
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [
          {
            id: 'member-1',
            role: WorkspaceRole.OWNER,
            user: { id: mockUser.id, name: mockUser.name, email: mockUser.email },
          },
        ],
        invitations: [],
      };

      const mockMember = {
        id: 'member-1',
        role: WorkspaceRole.OWNER,
        workspaceId,
        workspace: mockWorkspace,
      };

      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(mockMember as any);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue(mockWorkspace as any);

      const response = await request(app)
        .get(`/api/workspaces/${workspaceId}`)
        .set('Authorization', `Bearer ${mockToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(workspaceId);
      expect(response.body.data.role).toBe(WorkspaceRole.OWNER);
    });

    it('should forbid access if user is not a member of the workspace', async () => {
      const workspaceId = 'ws-123';

      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/workspaces/${workspaceId}`)
        .set('Authorization', `Bearer ${mockToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('not a member');
    });
  });

  describe('POST /api/workspaces/:workspaceId/invitations', () => {
    it('should create and return invitation details if invited by EDITOR or OWNER', async () => {
      const workspaceId = 'ws-123';
      const inviteData = {
        email: 'invitee@example.com',
        role: WorkspaceRole.EDITOR,
      };

      const mockMember = {
        id: 'member-1',
        role: WorkspaceRole.OWNER,
        workspaceId,
        workspace: {
          id: workspaceId,
          name: 'Workspace Name',
          description: null,
        },
      };

      const mockInvitation = {
        id: 'invite-id-123',
        workspaceId,
        email: inviteData.email,
        role: inviteData.role,
        token: 'invite-token-abc',
        expiresAt: new Date(),
        invitedBy: { id: mockUser.id, name: mockUser.name },
      };

      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(mockMember as any);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null); // invitee is not in DB yet
      vi.mocked(prisma.workspaceInvitation.upsert).mockResolvedValue(mockInvitation as any);

      const response = await request(app)
        .post(`/api/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${mockToken}`)
        .send(inviteData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.token).toBe(mockInvitation.token);
      expect(response.body.data.email).toBe(inviteData.email);
    });
  });

  describe('POST /api/workspaces/invitations/check/:token/accept', () => {
    it('should accept a pending invitation and add user to workspace', async () => {
      const token = 'invite-token-abc';
      const mockInvitation = {
        id: 'invite-id-123',
        workspaceId: 'ws-123',
        email: mockUser.email, // matches mockUser email
        role: WorkspaceRole.EDITOR,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60), // not expired
      };

      const mockMember = {
        id: 'new-member-id',
        workspaceId: 'ws-123',
        userId: mockUser.id,
        role: WorkspaceRole.EDITOR,
        workspace: {
          id: 'ws-123',
          name: 'Collab Workspace',
        },
      };

      vi.mocked(prisma.workspaceInvitation.findUnique).mockResolvedValue(mockInvitation as any);
      vi.mocked(prisma.workspaceMember.create).mockResolvedValue(mockMember as any);
      vi.mocked(prisma.workspaceInvitation.update).mockResolvedValue({ ...mockInvitation, status: 'ACCEPTED' } as any);

      // Mock transaction execution
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
        return fn(prisma);
      });

      const response = await request(app)
        .post(`/api/workspaces/invitations/check/${token}/accept`)
        .set('Authorization', `Bearer ${mockToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.workspace.id).toBe('ws-123');
      expect(response.body.data.workspace.role).toBe(WorkspaceRole.EDITOR);
    });
  });
});
