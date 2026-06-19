import { Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from './auth.js';

export interface WorkspaceRequest extends AuthRequest {
  workspaceMember?: {
    id: string;
    role: 'OWNER' | 'EDITOR' | 'VIEWER';
    workspaceId: string;
  };
}

/**
 * Middleware to enforce membership and role-based permissions in a workspace.
 * Requires requireAuth to be run first.
 * 
 * @param roles Array of allowed roles (e.g. ['OWNER', 'EDITOR'])
 */
export function requireWorkspaceRole(roles: ('OWNER' | 'EDITOR' | 'VIEWER')[]) {
  return async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      // Look for workspace ID in request parameters
      const workspaceId = req.params.workspaceId || req.params.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { message: 'Authentication required' },
        });
      }

      if (!workspaceId) {
        return res.status(400).json({
          success: false,
          error: { message: 'Workspace ID parameter is missing' },
        });
      }

      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId,
          },
        },
      });

      if (!member) {
        return res.status(403).json({
          success: false,
          error: { message: 'You are not a member of this workspace' },
        });
      }

      if (!roles.includes(member.role)) {
        return res.status(403).json({
          success: false,
          error: { message: 'You do not have permission to perform this action' },
        });
      }

      req.workspaceMember = {
        id: member.id,
        role: member.role,
        workspaceId: member.workspaceId,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}
