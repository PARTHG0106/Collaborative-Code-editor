import { Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from './auth.js';
import { WorkspaceRole } from '@prisma/client';

export interface WorkspaceRequest extends AuthRequest {
  workspace?: {
    id: string;
    name: string;
    description: string | null;
  };
  workspaceMember?: {
    id: string;
    role: WorkspaceRole;
  };
}

/**
 * Middleware to require that the authenticated user is a member of the workspace
 * and possesses one of the allowed roles.
 * Expects workspaceId to be passed in route parameters as :workspaceId (or optionally body/query).
 */
export function requireWorkspaceRole(allowedRoles: WorkspaceRole[]) {
  return async (req: WorkspaceRequest, res: Response, next: NextFunction) => {
    const workspaceId = req.params.workspaceId || req.body.workspaceId || req.query.workspaceId;

    if (!workspaceId || typeof workspaceId !== 'string') {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Workspace ID is missing or invalid',
          statusCode: 400,
        },
      });
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Authentication required',
          statusCode: 401,
        },
      });
    }

    try {
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.id,
          },
        },
        include: {
          workspace: true,
        },
      });

      if (!member) {
        return res.status(403).json({
          success: false,
          error: {
            message: 'You are not a member of this workspace',
            statusCode: 403,
          },
        });
      }

      if (!allowedRoles.includes(member.role)) {
        return res.status(403).json({
          success: false,
          error: {
            message: 'Insufficient permissions within this workspace',
            statusCode: 403,
          },
        });
      }

      // Attach workspace details to request for downstream routes
      req.workspace = {
        id: member.workspace.id,
        name: member.workspace.name,
        description: member.workspace.description,
      };

      req.workspaceMember = {
        id: member.id,
        role: member.role,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}
