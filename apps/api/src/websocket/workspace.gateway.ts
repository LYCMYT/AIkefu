import { Inject, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { hashWorkspaceToken, isWorkspaceToken } from '@ai-customer-service/core';
import type { Server, Socket } from 'socket.io';
import type { WorkspaceEventEnvelope } from '@ai-customer-service/contracts';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { WorkspaceService } from '../workspaces/workspace.service';

type WorkspaceSocket = Socket & {
  data: {
    workspace?: AuthenticatedWorkspace;
    tokenHash?: string;
    expiryTimer?: NodeJS.Timeout;
  };
};

@WebSocketGateway({
  path: process.env.WS_PATH ?? '/ws',
  transports: ['websocket'],
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' },
})
export class WorkspaceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  afterInit(server: Server): void {
    server.use(async (socket: WorkspaceSocket, next) => {
      try {
        const header = socket.handshake.headers['x-demo-workspace-token'];
        const token =
          (typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined) ??
          (Array.isArray(header) ? header[0] : header);
        if (!token) throw this.unauthorized('WORKSPACE_TOKEN_REQUIRED');
        if (!isWorkspaceToken(token)) throw this.unauthorized('WORKSPACE_TOKEN_INVALID');
        const tokenHash = hashWorkspaceToken(token);
        const context = await this.workspaces.authenticateHash(tokenHash);
        const shopId = typeof socket.handshake.auth?.shopId === 'string' ? socket.handshake.auth.shopId : undefined;
        if (shopId) await this.workspaces.getShop(context, shopId);
        socket.data.workspace = context;
        socket.data.tokenHash = tokenHash;
        next();
      } catch (error) {
        const code = this.errorCode(error);
        next(new Error(code));
      }
    });
  }

  handleConnection(client: WorkspaceSocket): void {
    const context = client.data.workspace;
    if (!context) {
      client.disconnect(true);
      return;
    }
    void client.join(this.room(context.workspaceId));
    this.scheduleExpiryCheck(client, context.workspace.expiresAt);
  }

  handleDisconnect(client: WorkspaceSocket): void {
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
  }

  @SubscribeMessage('workspace.heartbeat')
  async heartbeat(@ConnectedSocket() client: WorkspaceSocket) {
    return this.revalidate(client);
  }

  publish(event: WorkspaceEventEnvelope<unknown>): void {
    this.server.to(this.room(event.workspaceId)).emit('workspace.event', event);
  }

  private room(workspaceId: string): string {
    return `workspace:${workspaceId}`;
  }

  private unauthorized(code: string): UnauthorizedException {
    return new UnauthorizedException({ code, message: code });
  }

  private async revalidate(client: WorkspaceSocket) {
    const tokenHash = client.data.tokenHash;
    if (!tokenHash) {
      client.disconnect(true);
      throw this.unauthorized('WORKSPACE_TOKEN_REQUIRED');
    }
    try {
      const context = await this.workspaces.authenticateHash(tokenHash);
      client.data.workspace = context;
      this.scheduleExpiryCheck(client, context.workspace.expiresAt);
      return { workspaceId: context.workspaceId, occurredAt: new Date().toISOString() };
    } catch {
      client.disconnect(true);
      throw this.unauthorized('WORKSPACE_TOKEN_INVALID');
    }
  }

  private scheduleExpiryCheck(client: WorkspaceSocket, expiresAt: string): void {
    if (client.data.expiryTimer) clearTimeout(client.data.expiryTimer);
    const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    client.data.expiryTimer = setTimeout(() => {
      void this.revalidate(client).catch(() => undefined);
    }, delay);
    client.data.expiryTimer.unref();
  }

  private errorCode(error: unknown): string {
    if (error instanceof UnauthorizedException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response && 'code' in response) return String(response.code);
    }
    if (error && typeof error === 'object' && 'response' in error) {
      const response = (error as { response?: unknown }).response;
      if (response && typeof response === 'object' && 'code' in response) return String(response.code);
    }
    return 'WORKSPACE_ACCESS_DENIED';
  }
}
