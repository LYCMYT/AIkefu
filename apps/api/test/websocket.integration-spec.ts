import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { WORKSPACE_REPOSITORY } from '../src/workspaces/workspace.repository';
import { InMemoryWorkspaceRepository } from './workspace.repository.fake';

describe('Phase 01 WebSocket integration', () => {
  let app: INestApplication;
  let baseUrl: string;
  let repository: InMemoryWorkspaceRepository;

  beforeEach(async () => {
    repository = new InMemoryWorkspaceRepository();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WORKSPACE_REPOSITORY)
      .useValue(repository)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'string' ? 0 : address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('authenticates a workspace and answers heartbeat', async () => {
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const socket = io(baseUrl, { path: '/ws', transports: ['websocket'], auth: { token: session.token } });

    const ack = await new Promise<{ workspaceId: string; occurredAt: string }>((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.once('connect', () => socket.emit('workspace.heartbeat', {}, resolve));
    });

    expect(ack.workspaceId).toBe(session.workspace.id);
    expect(new Date(ack.occurredAt).toString()).not.toBe('Invalid Date');
    socket.disconnect();
  });

  it('rejects missing credentials during the handshake', async () => {
    const socket: Socket = io(baseUrl, { path: '/ws', transports: ['websocket'], reconnection: false });
    const message = await new Promise<string>((resolve) => {
      socket.once('connect_error', (error) => resolve(error.message));
    });
    expect(message).toContain('WORKSPACE_TOKEN_REQUIRED');
    socket.disconnect();
  });

  it('revalidates the workspace on heartbeat and disconnects an expired session', async () => {
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const socket = io(baseUrl, { path: '/ws', transports: ['websocket'], auth: { token: session.token } });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    repository.expireWorkspace(session.workspace.id);

    const reason = await new Promise<string>((resolve) => {
      socket.once('disconnect', resolve);
      socket.emit('workspace.heartbeat', {});
    });

    expect(reason).toBe('io server disconnect');
  });

});
