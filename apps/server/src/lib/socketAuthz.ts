import { prisma } from './prisma.js';

export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'VIEWER';

/** Roles allowed to mutate workspace content. */
export const WRITE_ROLES: WorkspaceRole[] = ['OWNER', 'EDITOR'];

/** Roles allowed to read workspace content. */
export const READ_ROLES: WorkspaceRole[] = ['OWNER', 'EDITOR', 'VIEWER'];

/**
 * Socket events fire far more often than HTTP requests (every keystroke, every
 * cursor move), so membership lookups are cached briefly. The window is short
 * enough that a revoked member loses access within seconds.
 */
const TTL_MS = 30_000;

const roleCache = new Map<string, { role: WorkspaceRole | null; expiresAt: number }>();
const fileWorkspaceCache = new Map<string, { workspaceId: string | null; expiresAt: number }>();

/** Raised when a socket event fails authorization. */
export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthzError';
  }
}

/**
 * Resolves a user's role in a workspace.
 *
 * Deliberately identical to the REST middleware in middleware/workspace.ts: a
 * workspaceMember row is the single source of truth, and the workspace owner is
 * expected to have an OWNER member row. No implicit owner bypass is added here,
 * so the two layers cannot drift apart.
 */
export async function getWorkspaceRole(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  if (!userId || !workspaceId || typeof workspaceId !== 'string') return null;

  const key = `${userId}:${workspaceId}`;
  const cached = roleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.role;
  }

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });

  const role = (member?.role as WorkspaceRole | undefined) ?? null;
  roleCache.set(key, { role, expiresAt: Date.now() + TTL_MS });
  return role;
}

/**
 * Throws unless the user holds one of the allowed roles in the workspace.
 * Returns the resolved role on success.
 */
export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  allowed: WorkspaceRole[],
): Promise<WorkspaceRole> {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new AuthzError('A valid workspaceId is required');
  }

  const role = await getWorkspaceRole(userId, workspaceId);

  if (!role) {
    throw new AuthzError('You are not a member of this workspace');
  }

  if (!allowed.includes(role)) {
    throw new AuthzError('You do not have permission to perform this action');
  }

  return role;
}

/**
 * Maps a file to its owning workspace. Without this, a file-scoped event only
 * proves the caller knows a file id, which is not proof of access.
 */
export async function getWorkspaceIdForFile(fileId: string): Promise<string | null> {
  if (!fileId || typeof fileId !== 'string') return null;

  const cached = fileWorkspaceCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.workspaceId;
  }

  const file = await prisma.fileSystemItem.findUnique({
    where: { id: fileId },
    select: { workspaceId: true },
  });

  const workspaceId = file?.workspaceId ?? null;
  fileWorkspaceCache.set(fileId, { workspaceId, expiresAt: Date.now() + TTL_MS });
  return workspaceId;
}

/**
 * Throws unless the user holds one of the allowed roles in the workspace that
 * owns the file. Returns the workspace id and role on success.
 */
export async function requireFileRole(
  userId: string,
  fileId: string,
  allowed: WorkspaceRole[],
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const workspaceId = await getWorkspaceIdForFile(fileId);

  if (!workspaceId) {
    throw new AuthzError('File not found');
  }

  const role = await requireWorkspaceRole(userId, workspaceId, allowed);
  return { workspaceId, role };
}

/**
 * Clears cached decisions. Call after membership or file changes so a removed
 * collaborator does not keep access for the remainder of the TTL.
 */
export function invalidateAuthz(args: {
  userId?: string;
  workspaceId?: string;
  fileId?: string;
}): void {
  const { userId, workspaceId, fileId } = args;

  if (fileId) {
    fileWorkspaceCache.delete(fileId);
  }

  if (userId && workspaceId) {
    roleCache.delete(`${userId}:${workspaceId}`);
    return;
  }

  if (workspaceId) {
    for (const key of roleCache.keys()) {
      if (key.endsWith(`:${workspaceId}`)) roleCache.delete(key);
    }
  }

  if (userId) {
    for (const key of roleCache.keys()) {
      if (key.startsWith(`${userId}:`)) roleCache.delete(key);
    }
  }
}
