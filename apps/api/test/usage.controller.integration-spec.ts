import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UsageService } from '../src/ai/usage.service';
import { WORKSPACE_REPOSITORY } from '../src/workspaces/workspace.repository';
import { InMemoryWorkspaceRepository } from './workspace.repository.fake';

describe('Phase 03 usage REST contract', () => {
  let app: INestApplication;
  const usage = { summary: jest.fn() };

  beforeEach(async () => {
    usage.summary.mockResolvedValue({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      estimatedCost: 0,
      failures: 1,
      fallbacks: 1,
      fastPathReplies: 1,
      byPurpose: {},
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WORKSPACE_REPOSITORY)
      .useValue(new InMemoryWorkspaceRepository())
      .overrideProvider(UsageService)
      .useValue(usage)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => app.close());

  it('requires a workspace token and derives the aggregate scope from it', async () => {
    await request(app.getHttpServer()).get('/api/usage').expect(401);
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const response = await request(app.getHttpServer())
      .get('/api/usage')
      .set('X-Demo-Workspace-Token', session.token)
      .expect(200);

    expect(response.body).toMatchObject({ calls: 2, failures: 1, fallbacks: 1 });
    expect(usage.summary).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: session.workspace.id,
      tenantId: session.tenant.id,
    }));
  });
});
