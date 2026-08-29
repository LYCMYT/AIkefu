import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WORKSPACE_REPOSITORY } from '../src/workspaces/workspace.repository';
import { InMemoryWorkspaceRepository } from './workspace.repository.fake';

describe('Phase 01 workspace integration', () => {
  let app: INestApplication;
  let repository: InMemoryWorkspaceRepository;

  beforeEach(async () => {
    repository = new InMemoryWorkspaceRepository();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WORKSPACE_REPOSITORY)
      .useValue(repository)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects protected REST calls without a demo token', async () => {
    const response = await request(app.getHttpServer()).get('/api/bootstrap').expect(401);
    expect(response.body.error.code).toBe('WORKSPACE_TOKEN_REQUIRED');
    expect(response.body.error.requestId).toBeDefined();
  });

  it('isolates Workspace A/B and rejects a forged shop id', async () => {
    const sessionA = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const sessionB = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;

    expect(sessionA.workspace.id).not.toBe(sessionB.workspace.id);
    const shopsA = (
      await request(app.getHttpServer())
        .get('/api/shops')
        .set('X-Demo-Workspace-Token', sessionA.token)
        .expect(200)
    ).body;
    const shopsB = (
      await request(app.getHttpServer())
        .get('/api/shops')
        .set('X-Demo-Workspace-Token', sessionB.token)
        .expect(200)
    ).body;

    expect(shopsA).toHaveLength(2);
    expect(shopsB).toHaveLength(2);
    expect(shopsA.map((shop: { id: string }) => shop.id)).not.toEqual(
      shopsB.map((shop: { id: string }) => shop.id),
    );
    await request(app.getHttpServer())
      .get(`/api/shops/${shopsB[0].id}`)
      .set('X-Demo-Workspace-Token', sessionA.token)
      .expect(404);
  });

  it('creates and resets an explicitly EMPTY operational workspace without changing the seeded default', async () => {
    const empty = (await request(app.getHttpServer())
      .post('/api/demo/workspaces')
      .send({ profile: 'EMPTY' })
      .expect(201)).body;
    const emptyHeader = { 'X-Demo-Workspace-Token': empty.token };

    const emptyBootstrap = await request(app.getHttpServer()).get('/api/bootstrap').set(emptyHeader).expect(200);
    expect(emptyBootstrap.body.shops).toEqual([]);
    expect(emptyBootstrap.body.seed.counts).toMatchObject({ shops: 0, buyers: 0, products: 0, orders: 0, knowledge: 0, workflows: 0 });

    const seeded = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const seededBootstrap = await request(app.getHttpServer())
      .get('/api/bootstrap')
      .set('X-Demo-Workspace-Token', seeded.token)
      .expect(200);
    expect(seededBootstrap.body.shops).toHaveLength(2);

    await request(app.getHttpServer())
      .post('/api/shops').set(emptyHeader)
      .send({ platform: 'DOUYIN_DEMO', templateKey: 'TECH_DEMO', name: '空间新店' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/demo/workspaces/current/reset')
      .set(emptyHeader)
      .send({ profile: 'EMPTY' })
      .expect(202);
    const reset = await request(app.getHttpServer()).get('/api/bootstrap').set(emptyHeader).expect(200);
    expect(reset.body.shops).toEqual([]);
  });

  it('requires an allowlisted shop template, creates it in scope, and changes its explicit AI ceiling', async () => {
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const header = { 'X-Demo-Workspace-Token': session.token };

    await request(app.getHttpServer()).post('/api/shops').set(header).send({}).expect(400);
    await request(app.getHttpServer())
      .post('/api/shops').set(header)
      .send({ platform: 'DOUYIN_DEMO', templateKey: 'BLANK', name: '不允许的模板' })
      .expect(400);

    const created = await request(app.getHttpServer())
      .post('/api/shops').set(header)
      .send({ platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: '验收店铺' })
      .expect(201);
    expect(created.body).toMatchObject({
      name: '验收店铺', platform: 'DOUYIN_DEMO', aiMode: 'AUTO_ALLOWED', aiReadiness: 'PREPARING',
    });

    const raised = await request(app.getHttpServer())
      .patch(`/api/shops/${created.body.id}/ai-mode`).set(header)
      .send({ mode: 'AUTO_ALLOWED' })
      .expect(200);
    expect(raised.body).toMatchObject({ id: created.body.id, aiMode: 'AUTO_ALLOWED' });
    const shops = await request(app.getHttpServer()).get('/api/shops').set(header).expect(200);
    expect(shops.body).toHaveLength(3);
  });

  it('resets only A and keeps seed repeatable and idempotent', async () => {
    const sessionA = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const sessionB = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const headerA = { 'X-Demo-Workspace-Token': sessionA.token };
    const headerB = { 'X-Demo-Workspace-Token': sessionB.token };

    await repository.addRuntimeConversation(sessionA.workspace.id, sessionA.tenant.id);
    await repository.addRuntimeConversation(sessionB.workspace.id, sessionB.tenant.id);
    const shopsBeforeB = (
      await request(app.getHttpServer()).get('/api/shops').set(headerB).expect(200)
    ).body;

    const firstResetOperation = await request(app.getHttpServer())
      .post('/api/demo/workspaces/current/reset')
      .set(headerA)
      .expect(202);
    const firstReset = await request(app.getHttpServer()).get('/api/bootstrap').set(headerA).expect(200);
    const secondResetOperation = await request(app.getHttpServer())
      .post('/api/demo/workspaces/current/reset')
      .set(headerA)
      .expect(202);
    const secondReset = await request(app.getHttpServer()).get('/api/bootstrap').set(headerA).expect(200);
    const bootstrapB = await request(app.getHttpServer()).get('/api/bootstrap').set(headerB).expect(200);

    expect(firstResetOperation.body).toMatchObject({ status: 'ACCEPTED' });
    expect(secondResetOperation.body).toMatchObject({ status: 'ACCEPTED' });
    expect(firstReset.body.seed.counts).toEqual(secondReset.body.seed.counts);
    expect(firstReset.body.seed.counts).toMatchObject({ shops: 2, buyers: 4, products: 10, orders: 10, knowledge: 80, workflows: 2 });
    expect(repository.runtimeConversationCount(sessionA.workspace.id)).toBe(0);
    expect(repository.runtimeConversationCount(sessionB.workspace.id)).toBe(1);
    expect(bootstrapB.body.workspace.id).toBe(sessionB.workspace.id);
    expect(bootstrapB.body.shops.map((shop: { id: string }) => shop.id)).toEqual(
      shopsBeforeB.map((shop: { id: string }) => shop.id),
    );
  });

  it('refreshes active access and removes only expired workspaces', async () => {
    const expired = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const active = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    repository.expireWorkspace(expired.workspace.id);

    const deleted = await repository.deleteExpired(new Date());
    expect(deleted).toBe(1);
    await request(app.getHttpServer())
      .get('/api/demo/workspaces/current')
      .set('X-Demo-Workspace-Token', expired.token)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/demo/workspaces/current')
      .set('X-Demo-Workspace-Token', active.token)
      .expect(200);
  });
});
