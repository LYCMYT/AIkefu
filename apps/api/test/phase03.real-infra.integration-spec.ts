import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

const describeRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1' && process.env.DATABASE_URL
  ? describe
  : describe.skip;

/**
 * Opt-in acceptance suite for the infrastructure paths unavailable in the
 * default offline Gate. Run after `pnpm infra:up && pnpm db:deploy` with
 * RUN_REAL_INFRA_INTEGRATION=1. It never calls a commerce platform or model.
 */
describeRealInfra('Phase 03 real PostgreSQL/pgvector/MinIO acceptance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let workspaceId: string;
  let shops: Array<{ id: string }>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    token = session.token;
    workspaceId = session.workspace.id;
    shops = (await request(app.getHttpServer())
      .get('/api/shops')
      .set('X-Demo-Workspace-Token', token)
      .expect(200)).body;
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await app?.close();
  });

  it('has pgvector and the Phase 03 HNSW knowledge index deployed', async () => {
    const extensions = await prisma.$queryRawUnsafe<Array<{ extname: string }>>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'KnowledgeVersion_embedding_hnsw_ready_idx'",
    );
    expect(extensions).toEqual([{ extname: 'vector' }]);
    expect(indexes).toEqual([{ indexname: 'KnowledgeVersion_embedding_hnsw_ready_idx' }]);
  });

  it('persists and retrieves knowledge without leaking the created evidence to another shop', async () => {
    const header = { 'X-Demo-Workspace-Token': token };
    const created = (await request(app.getHttpServer())
      .post('/api/knowledge')
      .set(header)
      .send({
        shopId: shops[0]!.id,
        scope: 'STORE',
        question: '合成验收暗号是什么？',
        answer: '仅本店回答：蓝色风铃。',
      })
      .expect(201)).body;
    const createdId = created.knowledge.id as string;

    const own = (await request(app.getHttpServer())
      .post('/api/knowledge/search')
      .set(header)
      .send({ shopId: shops[0]!.id, query: '合成验收暗号', topK: 3 })
      .expect(201)).body;
    const other = (await request(app.getHttpServer())
      .post('/api/knowledge/search')
      .set(header)
      .send({ shopId: shops[1]!.id, query: '合成验收暗号', topK: 3 })
      .expect(201)).body;

    expect(own.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: createdId })]));
    expect(other.evidence ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ itemId: createdId })]));
  });

  it('round-trips an attachment through configured MinIO using only a short-lived signed URL', async () => {
    const header = { 'X-Demo-Workspace-Token': token };
    const buyers = (await request(app.getHttpServer())
      .get(`/api/buyers?shopId=${shops[0]!.id}`)
      .set(header)
      .expect(200)).body;
    const uploaded = (await request(app.getHttpServer())
      .post('/api/attachments')
      .set(header)
      .field('shopId', shops[0]!.id)
      .field('buyerId', buyers[0].id)
      .attach('file', PNG, { filename: 'synthetic.png', contentType: 'image/png' })
      .expect(201)).body;
    const signed = (await request(app.getHttpServer())
      .get(`/api/attachments/${uploaded.id}/signed-url?shopId=${shops[0]!.id}`)
      .set(header)
      .expect(200)).body;

    expect(signed.url).toMatch(/^https?:\/\//);
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await request(app.getHttpServer()).delete(`/api/attachments/${uploaded.id}?shopId=${shops[0]!.id}`).set(header).expect(200);
  });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
