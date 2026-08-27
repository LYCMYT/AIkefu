import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isWorkspaceToken } from '@ai-customer-service/core';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import type { WorkspaceRequest } from './workspace-request';
import { WorkspaceService } from '../workspaces/workspace.service';

@Injectable()
export class WorkspaceAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(WorkspaceService) private readonly workspaces: WorkspaceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<WorkspaceRequest>();
    const rawToken = request.headers['x-demo-workspace-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (!token) {
      throw new UnauthorizedException({
        code: 'WORKSPACE_TOKEN_REQUIRED',
        message: 'X-Demo-Workspace-Token is required',
      });
    }
    if (!isWorkspaceToken(token)) {
      throw new UnauthorizedException({
        code: 'WORKSPACE_TOKEN_INVALID',
        message: 'Demo workspace token is invalid or expired',
      });
    }

    request.workspace = await this.workspaces.authenticate(token);
    return true;
  }
}
