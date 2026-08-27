import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { WORKSPACE_REPOSITORY } from '../src/workspaces/workspace.repository';
import { InMemoryWorkspaceRepository } from './workspace.repository.fake';

describe('Phase 03 knowledge REST contracts', () => {
  let app: INestApplication;
  const knowledge = {
    create: jest.fn(),
    previewImport: jest.fn(),
    getImport: jest.fn(),
    commitImport: jest.fn(),
    listCandidates: jest.fn(),
    approveCandidate: jest.fn(),
    rejectCandidate: jest.fn(),
    listConflicts: jest.fn(),
    getConflict: jest.fn(),
    resolveConflict: jest.fn(),
    reindex: jest.fn(),
    revise: jest.fn(),
    delete: jest.fn(),
    listProductLearningJobs: jest.fn(),
  };

  beforeEach(async () => {
    for (const method of Object.values(knowledge)) method.mockReset();
    knowledge.create.mockResolvedValue({ status: 'CREATED' });
    knowledge.previewImport.mockResolvedValue({ id: 'import-a' });
    knowledge.getImport.mockResolvedValue({ id: 'import-a', status: 'PREVIEWED' });
    knowledge.commitImport.mockResolvedValue({ id: 'import-a', status: 'COMMITTED' });
    knowledge.listCandidates.mockResolvedValue([]);
    knowledge.approveCandidate.mockResolvedValue({ operationId: 'candidate-a', status: 'ACCEPTED' });
    knowledge.rejectCandidate.mockResolvedValue(undefined);
    knowledge.listConflicts.mockResolvedValue([]);
    knowledge.getConflict.mockResolvedValue({ id: 'conflict-a', left: { question: 'q', answer: 'a' } });
    knowledge.resolveConflict.mockResolvedValue({ operationId: 'conflict-a', status: 'ACCEPTED' });
    knowledge.reindex.mockResolvedValue({ id: 'version-2' });
    knowledge.revise.mockResolvedValue({ status: 'UPDATED' });
    knowledge.delete.mockResolvedValue(undefined);
    knowledge.listProductLearningJobs.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WORKSPACE_REPOSITORY)
      .useValue(new InMemoryWorkspaceRepository())
      .overrideProvider(KnowledgeService)
      .useValue(knowledge)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps OpenAPI id routes usable without client-supplied shopId and returns the frozen status codes', async () => {
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const header = { 'X-Demo-Workspace-Token': session.token };

    await request(app.getHttpServer())
      .post('/api/knowledge/imports')
      .set(header)
      .send({ shopId: 'shop-a', csv: 'question,answer\n材质,316L' })
      .expect(202)
      .expect({ status: 'ACCEPTED', operationId: 'import-a', importId: 'import-a' });
    await request(app.getHttpServer()).get('/api/knowledge/imports/import-a').set(header).expect(200);
    await request(app.getHttpServer()).post('/api/knowledge/imports/import-a/commit').set(header).send({}).expect(201);
    await request(app.getHttpServer()).get('/api/knowledge/candidates').set(header).expect(200);
    await request(app.getHttpServer()).get('/api/knowledge/candidates?shopId=shop-a').set(header).expect(200);
    await request(app.getHttpServer()).post('/api/knowledge/candidates/candidate-a/approve').set(header).expect(202);
    await request(app.getHttpServer()).post('/api/knowledge/candidates/candidate-a/reject').set(header).expect(204);
    await request(app.getHttpServer()).get('/api/knowledge/conflicts').set(header).expect(200);
    await request(app.getHttpServer()).get('/api/knowledge/conflicts?shopId=shop-a').set(header).expect(200);
    await request(app.getHttpServer()).get('/api/knowledge/conflicts/conflict-a').set(header).expect(200);
    await request(app.getHttpServer())
      .post('/api/knowledge/conflicts/conflict-a/resolve')
      .set(header)
      .send({ resolution: 'MERGE', customQuestion: '材质是什么？', customAnswer: '以商品详情页为准。' })
      .expect(202);
    await request(app.getHttpServer()).post('/api/knowledge/knowledge-a/reindex').set(header).expect(202);
    await request(app.getHttpServer()).patch('/api/knowledge/knowledge-a').set(header).send({ answer: 'new' }).expect(202);
    await request(app.getHttpServer()).delete('/api/knowledge/knowledge-a').set(header).expect(204);
    await request(app.getHttpServer()).get('/api/shops/shop-a/product-learning-jobs').set(header).expect(200);

    expect(knowledge.getImport).toHaveBeenCalledWith(expect.any(Object), 'import-a', undefined);
    expect(knowledge.commitImport).toHaveBeenCalledWith(expect.any(Object), 'import-a', undefined);
    expect(knowledge.listCandidates).toHaveBeenCalledWith(expect.any(Object), '', undefined);
    expect(knowledge.listCandidates).toHaveBeenCalledWith(expect.any(Object), 'shop-a', undefined);
    expect(knowledge.approveCandidate).toHaveBeenCalledWith(expect.any(Object), 'candidate-a', undefined);
    expect(knowledge.rejectCandidate).toHaveBeenCalledWith(expect.any(Object), 'candidate-a', undefined);
    expect(knowledge.listConflicts).toHaveBeenCalledWith(expect.any(Object), '', undefined);
    expect(knowledge.listConflicts).toHaveBeenCalledWith(expect.any(Object), 'shop-a', undefined);
    expect(knowledge.getConflict).toHaveBeenCalledWith(expect.any(Object), 'conflict-a', undefined);
    expect(knowledge.resolveConflict).toHaveBeenCalledWith(expect.any(Object), 'conflict-a', {
      shopId: undefined,
      resolution: 'MERGE',
      customQuestion: '材质是什么？',
      customAnswer: '以商品详情页为准。',
    });
    expect(knowledge.reindex).toHaveBeenCalledWith(expect.any(Object), 'knowledge-a', undefined);
    expect(knowledge.revise).toHaveBeenCalledWith(expect.any(Object), 'knowledge-a', {
      shopId: undefined,
      question: undefined,
      answer: 'new',
    });
    expect(knowledge.delete).toHaveBeenCalledWith(expect.any(Object), 'knowledge-a', undefined);
  });
});
