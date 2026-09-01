import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

const describeRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1' && process.env.DATABASE_URL
  ? describe
  : describe.skip;

const externalAiEnvKeys = [
  'AI_BASE_URL',
  'AI_MODEL_GATEWAY_URL',
  'AI_API_KEY',
  'AI_MODEL_GATEWAY_SECRET',
  'AI_MODEL_NAME',
  'AI_FAST_MODEL',
  'AI_QUALITY_MODEL',
] as const;

/**
 * Opt-in PostgreSQL boundary for the synthetic Scenario Lab. The default test
 * run skips this suite when local infrastructure is absent; it never treats a
 * browser animation or an in-memory fake as a persistence acceptance.
 */
describeRealInfra('Scenario Lab real PostgreSQL boundary', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let workspaceId: string;
  const originalAiEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    // Case07 acceptance must never depend on a configured external model.
    // AppModule reads these when constructing the runtime, so force its
    // existing deterministic offline provider for this opt-in DB test.
    for (const key of externalAiEnvKeys) {
      originalAiEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    const created = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body as { token: string; workspace: { id: string } };
    token = created.token;
    workspaceId = created.workspace.id;
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await app?.close();
    for (const key of externalAiEnvKeys) {
      const original = originalAiEnvironment.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('lists the fixed eight scenarios and keeps run/reset scoped to the current workspace', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/scenarios')
      .set('X-Demo-Workspace-Token', token)
      .expect(200);
    expect(list.body).toHaveLength(8);
    expect(list.body.every((scenario: { synthetic: boolean }) => scenario.synthetic === true)).toBe(true);

    const run = await request(app.getHttpServer())
      .post('/api/scenarios/duplicate_and_reorder/run')
      .set('X-Demo-Workspace-Token', token)
      .expect(202);
    expect(run.body).toEqual({ operationId: expect.any(String), status: 'ACCEPTED' });

    const afterRun = await request(app.getHttpServer())
      .get('/api/scenarios')
      .set('X-Demo-Workspace-Token', token)
      .expect(200);
    const scenario = afterRun.body.find((entry: { key: string }) => entry.key === 'duplicate_and_reorder');
    expect(scenario).toMatchObject({ status: 'SUCCEEDED', synthetic: true });
    expect(scenario.steps.every((step: { status: string }) => step.status === 'SUCCEEDED')).toBe(true);

    const reset = await request(app.getHttpServer())
      .post('/api/scenarios/duplicate_and_reorder/reset')
      .set('X-Demo-Workspace-Token', token)
      .expect(202);
    expect(reset.body).toEqual({ operationId: expect.any(String), status: 'ACCEPTED' });
    const afterReset = await request(app.getHttpServer())
      .get('/api/scenarios')
      .set('X-Demo-Workspace-Token', token)
      .expect(200);
    expect(afterReset.body.find((entry: { key: string }) => entry.key === 'duplicate_and_reorder')).toMatchObject({ status: 'READY', traceId: null });
  });

  it('Case01 reports success only after the real Message → UserTurn → Task → ReplyJob chain is durable', async () => {
    const runResponse = await request(app.getHttpServer())
      .post('/api/scenarios/continuous_messages/run')
      .set('X-Demo-Workspace-Token', token);
    if (runResponse.status !== 202) {
      const failure = await prisma.traceEvent.findFirst({
        where: { workspaceId, stage: 'SCENARIO_SNAPSHOT', traceId: { contains: ':continuous_messages:' } },
        orderBy: { createdAt: 'desc' },
        select: { payloadJson: true },
      });
      throw new Error(`Case01 failed with ${runResponse.status}: ${JSON.stringify(failure?.payloadJson ?? runResponse.body)}`);
    }

    const list = await request(app.getHttpServer())
      .get('/api/scenarios')
      .set('X-Demo-Workspace-Token', token)
      .expect(200);
    const scenario = list.body.find((entry: { key: string }) => entry.key === 'continuous_messages');
    expect(scenario).toMatchObject({ status: 'SUCCEEDED', synthetic: true });
    expect(scenario.steps.find((step: { key: string }) => step.key === 'reply-plan')?.actual).toBe('2 Task；1 ReplyJob');

    const conversations = await prisma.conversation.findMany({
      where: { workspaceId, externalConversationId: { startsWith: 'scenario:continuous_messages:' } },
      select: { id: true },
    });
    expect(conversations).toHaveLength(1);
    const conversationId = conversations[0]!.id;
    const [messages, userTurns, tasks, replyJobs] = await Promise.all([
      prisma.message.count({ where: { workspaceId, conversationId } }),
      prisma.userTurn.count({ where: { workspaceId, conversationId } }),
      prisma.task.count({ where: { workspaceId, conversationId } }),
      prisma.replyJob.count({ where: { workspaceId, conversationId, status: { notIn: ['STALE', 'EXPIRED', 'CANCELLED'] } } }),
    ]);
    expect({ messages, userTurns, tasks, replyJobs }).toEqual({ messages: 3, userTurns: 1, tasks: 2, replyJobs: 1 });
  }, 30_000);

  it('Case05 proves stale old generation is not deliverable and the replacement is grounded, guarded, sent, and projected', async () => {
    const mia = await prisma.shop.findFirstOrThrow({ where: { workspaceId, seedKey: 'shop_mia_fashion' }, select: { id: true, tenantId: true } });
    await request(app.getHttpServer())
      .patch(`/api/shops/${mia.id}/ai-mode`)
      .set('X-Demo-Workspace-Token', token)
      .send({ mode: 'AUTO_ALLOWED' })
      .expect(200);

    const runResponse = await request(app.getHttpServer())
      .post('/api/scenarios/message_during_generation/run')
      .set('X-Demo-Workspace-Token', token);
    if (runResponse.status !== 202) {
      const failure = await prisma.traceEvent.findFirst({
        where: { workspaceId, stage: 'SCENARIO_SNAPSHOT', traceId: { contains: ':message_during_generation:' } },
        orderBy: { createdAt: 'desc' }, select: { payloadJson: true },
      });
      throw new Error(`Case05 failed with ${runResponse.status}: ${JSON.stringify(failure?.payloadJson ?? runResponse.body)}`);
    }

    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { workspaceId, tenantId: mia.tenantId, shopId: mia.id, externalConversationId: { startsWith: 'scenario:message_during_generation:' } },
      select: { id: true, contextVersion: true },
    });
    const jobs = await prisma.replyJob.findMany({
      where: { workspaceId, tenantId: mia.tenantId, shopId: mia.id, conversationId: conversation.id },
      orderBy: { createdAt: 'asc' }, select: { id: true, status: true, staleReason: true },
    });
    const oldJob = jobs.find((job) => job.status === 'STALE');
    const newJob = jobs.find((job) => job.status === 'SENT');
    expect(oldJob).toMatchObject({ status: 'STALE', staleReason: 'NEW_BUYER_MESSAGE' });
    expect(newJob).toBeDefined();
    expect(conversation.contextVersion).toBeGreaterThan(1);

    const [oldOutboxes, newOutbox, evidence, trace, messages] = await Promise.all([
      prisma.sendOutbox.findMany({ where: { workspaceId, tenantId: mia.tenantId, replyJobId: oldJob!.id }, select: { status: true } }),
      prisma.sendOutbox.findFirstOrThrow({ where: { workspaceId, tenantId: mia.tenantId, replyJobId: newJob!.id, status: 'SENT' }, select: { id: true, receiptJson: true } }),
      prisma.replyEvidence.findMany({ where: { workspaceId, tenantId: mia.tenantId, replyJobId: newJob!.id }, select: { scope: true, retrievedContentSnapshotJson: true } }),
      prisma.traceEvent.findMany({ where: { workspaceId, tenantId: mia.tenantId, replyJobId: newJob!.id, stage: { in: ['EVIDENCE', 'SEND_GUARD', 'SEND_RECEIPT'] } }, select: { stage: true } }),
      prisma.message.findMany({ where: { workspaceId, tenantId: mia.tenantId, conversationId: conversation.id }, orderBy: { sequence: 'asc' }, select: { role: true, externalMessageId: true, contentJson: true } }),
    ]);
    expect(oldOutboxes.some((outbox) => ['PENDING', 'SENDING', 'SENT', 'UNCERTAIN'].includes(outbox.status))).toBe(false);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((entry) => {
      const snapshot = entry.retrievedContentSnapshotJson as { question?: unknown; answer?: unknown };
      return /新疆|偏远地区/.test(`${String(snapshot.question ?? '')} ${String(snapshot.answer ?? '')}`);
    })).toBe(true);
    expect(new Set(trace.map((entry) => entry.stage))).toEqual(new Set(['EVIDENCE', 'SEND_GUARD', 'SEND_RECEIPT']));
    const receipt = newOutbox.receiptJson as { externalMessageId?: unknown };
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'ASSISTANT',
        externalMessageId: typeof receipt.externalMessageId === 'string' ? receipt.externalMessageId : newOutbox.id,
        contentJson: expect.objectContaining({ text: expect.stringMatching(/新疆|偏远地区|实际物流/) }),
      }),
    ]));
  }, 45_000);

  it('Case07 persists grounded per-shop replies, evidence snapshots, and scoped trace without cross-shop knowledge', async () => {
    const runResponse = await request(app.getHttpServer())
      .post('/api/scenarios/two_shops/run')
      .set('X-Demo-Workspace-Token', token);
    if (runResponse.status !== 202) {
      const failure = await prisma.traceEvent.findFirst({
        where: { workspaceId, stage: 'SCENARIO_SNAPSHOT', traceId: { contains: ':two_shops:' } },
        orderBy: { createdAt: 'desc' },
        select: { payloadJson: true },
      });
      throw new Error(`Case07 failed with ${runResponse.status}: ${JSON.stringify(failure?.payloadJson ?? runResponse.body)}`);
    }

    const shops = await prisma.shop.findMany({
      where: { workspaceId },
      select: { id: true, tenantId: true, seedKey: true },
    });
    const mia = shops.find((shop) => shop.seedKey === 'shop_mia_fashion')!;
    const pixel = shops.find((shop) => shop.seedKey === 'shop_pixel_tech')!;
    expect(mia).toBeDefined();
    expect(pixel).toBeDefined();
    const tenantId = mia.tenantId;
    const conversations = await prisma.conversation.findMany({
      where: { workspaceId, tenantId, externalConversationId: { startsWith: 'scenario:two_shops:' } },
      select: { id: true, shopId: true },
    });
    expect(conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ shopId: mia.id }),
      expect.objectContaining({ shopId: pixel.id }),
    ]));
    const conversationIds = conversations.map((conversation) => conversation.id);
    const replyJobs = await prisma.replyJob.findMany({
      where: { workspaceId, tenantId, conversationId: { in: conversationIds }, shopId: { in: [mia.id, pixel.id] } },
      select: { id: true, shopId: true },
    });
    expect(replyJobs).toHaveLength(2);
    const replyJobIds = replyJobs.map((replyJob) => replyJob.id);
    const evidence = await prisma.replyEvidence.findMany({
      where: { workspaceId, tenantId, replyJobId: { in: replyJobIds } },
      select: { shopId: true, replyJobId: true, knowledgeItemId: true, knowledgeVersionId: true, scope: true, retrievedContentSnapshotJson: true },
    });
    // Frozen retrieval policy is TopK <= 3, not exactly one hit per shop.
    // Require at least one grounded STORE snapshot for each reply while also
    // proving the bounded fan-out and strict per-shop ownership.
    expect(evidence.length).toBeGreaterThanOrEqual(2);
    expect(evidence.length).toBeLessThanOrEqual(6);
    for (const replyJob of replyJobs) {
      const rows = evidence.filter((entry) => entry.replyJobId === replyJob.id);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(3);
      expect(rows.every((entry) => entry.shopId === replyJob.shopId && entry.scope === 'STORE')).toBe(true);
    }
    const itemIds = evidence.map((entry) => entry.knowledgeItemId);
    const items = await prisma.knowledgeItem.findMany({
      where: { workspaceId, tenantId, id: { in: itemIds } },
      select: { id: true, shopId: true, scope: true },
    });
    const itemShop = new Map(items.map((item) => [item.id, item.shopId]));
    expect(evidence.every((entry) => entry.scope === 'STORE' && itemShop.get(entry.knowledgeItemId) === entry.shopId)).toBe(true);
    expect(new Set(evidence.map((entry) => entry.knowledgeItemId)).size).toBeGreaterThanOrEqual(2);

    const [drafts, sendOutboxes] = await Promise.all([
      prisma.replyDraft.findMany({
        where: { workspaceId, tenantId, replyJobId: { in: replyJobIds }, status: { in: ['WAITING_HUMAN', 'SENT'] } },
        select: { replyJobId: true, aiDraft: true, humanFinal: true },
      }),
      prisma.sendOutbox.findMany({
        where: { workspaceId, tenantId, replyJobId: { in: replyJobIds }, status: { in: ['PENDING', 'SENDING', 'SENT'] } },
        select: { replyJobId: true, payloadJson: true },
      }),
    ]);
    const answerFor = (entry: typeof evidence[number]) => {
      const snapshot = entry.retrievedContentSnapshotJson as { answer?: unknown };
      return typeof snapshot.answer === 'string' ? snapshot.answer : '';
    };
    // Retrieval is TopK and the database query intentionally has no ordering
    // contract.  A grounded reply may therefore use any frozen Evidence row
    // for its ReplyJob, rather than whichever row PostgreSQL returns first.
    // Each shop may legitimately finish as an ASSIST draft or an AUTO
    // SendOutbox depending on its live mode/readiness.  Both are production
    // response artifacts and must remain grounded in that ReplyJob's frozen
    // STORE evidence.
    for (const replyJobId of replyJobIds) {
      const responseTexts = [
        ...drafts
          .filter((draft) => draft.replyJobId === replyJobId)
          .map((draft) => draft.humanFinal ?? draft.aiDraft),
        ...sendOutboxes
          .filter((outbox) => outbox.replyJobId === replyJobId)
          .map((outbox) => (outbox.payloadJson as { text?: unknown }).text)
          .filter((text): text is string => typeof text === 'string'),
      ];
      const evidenceAnswers = evidence
        .filter((entry) => entry.replyJobId === replyJobId)
        .map(answerFor)
        .filter(Boolean);
      expect(responseTexts.length).toBeGreaterThanOrEqual(1);
      expect(responseTexts.some((text) => evidenceAnswers.some((answer) => text.includes(answer)))).toBe(true);
    }

    const traces = await prisma.traceEvent.findMany({
      where: { workspaceId, tenantId, stage: 'SCENARIO_CASE07_EVIDENCE', replyJobId: { in: replyJobIds } },
      select: { shopId: true, replyJobId: true, payloadJson: true },
    });
    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => {
      const payload = trace.payloadJson as { knowledgeItemIds?: unknown; knowledgeVersionIds?: unknown };
      const rows = evidence.filter((entry) => entry.replyJobId === trace.replyJobId);
      const itemIds = new Set(rows.map((entry) => entry.knowledgeItemId));
      const versionIds = new Set(rows.map((entry) => entry.knowledgeVersionId));
      return Boolean(
        rows.length > 0
        && rows.every((row) => trace.shopId === row.shopId)
        && Array.isArray(payload.knowledgeItemIds)
        && payload.knowledgeItemIds.length === itemIds.size
        && payload.knowledgeItemIds.every((id) => typeof id === 'string' && itemIds.has(id))
        && Array.isArray(payload.knowledgeVersionIds)
        && payload.knowledgeVersionIds.length === versionIds.size
        && payload.knowledgeVersionIds.every((id) => typeof id === 'string' && versionIds.has(id)),
      );
    })).toBe(true);
  }, 30_000);
});
