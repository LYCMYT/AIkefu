import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

const describeRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1' && process.env.DATABASE_URL
  ? describe
  : describe.skip;

const externalAiEnvKeys = [
  'AI_PROVIDER',
  'AI_BASE_URL',
  'AI_MODEL_GATEWAY_URL',
  'AI_API_KEY',
  'AI_API_KEY_FILE',
  'AI_MODEL_GATEWAY_SECRET',
  'AI_MODEL_NAME',
  'AI_FAST_MODEL',
  'AI_QUALITY_MODEL',
  'AI_OFFLINE_MODE',
] as const;

type ShowcaseScope = {
  token: string;
  header: { 'X-Demo-Workspace-Token': string };
  workspaceId: string;
  tenantId: string;
  shopId: string;
  buyerId: string;
};

let livePrisma: PrismaService | undefined;

/**
 * These are deliberately live, opt-in acceptance tests. They exercise the
 * public API, authenticated WebSocket, PostgreSQL state and MockDouyin
 * dispatch together; no in-memory application, mocked provider, or forged
 * reply result is used as proof for the Showcase claims.
 */
describeRealInfra('Showcase SC05/SC06 real service chain', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const workspaceIds: string[] = [];
  const originalEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    // Safe greeting must be independent of external model availability. The
    // actual ReplyRuntime, database, WebSocket and MockDouyin adapters remain
    // live; only unrelated configured provider credentials are removed.
    for (const key of externalAiEnvKeys) {
      originalEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.AI_OFFLINE_MODE = '1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    livePrisma = prisma;
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'string' ? 0 : address.port}`;
  });

  afterAll(async () => {
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await app?.close();
    livePrisma = undefined;
    for (const key of externalAiEnvKeys) {
      const original = originalEnvironment.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('SC05 serves the six-scenario catalog and sends a natural fact-free greeting with no knowledge evidence', async () => {
    const scope = await createScope();
    const socket = await connect(scope.token);
    const events: Array<{ eventType?: string; workspaceId?: string }> = [];
    socket.on('workspace.event', (event) => events.push(event));
    try {
      const catalog = await request(app.getHttpServer())
        .get('/api/showcase/catalog')
        .set(scope.header)
        .expect(200);
      expect(catalog.body.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual([
        'SC-01-PRODUCT-CARE',
        'SC-02-MULTI-TURN',
        'SC-03-STALE-REPLAN',
        'SC-04-IMAGE-HUMAN',
        'SC-05-SAFE-GREETING',
        'SC-06-SHOP-AI-OFF',
      ]);

      // The runner establishes the catalog's AUTO_ALLOWED baseline before
      // dispatching the scenario action. Fresh seeded workspaces start in
      // assist mode, so preserve that real runner transition here.
      await setShopAiMode(scope, 'AUTO_ALLOWED');
      await sendBuyerText(scope, '你好！');
      const completed = await waitFor(async () => {
        const conversation = await prisma.conversation.findFirst({
          where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, buyerId: scope.buyerId },
          select: { id: true },
        });
        if (!conversation) return undefined;
        const [buyer, job, task, outbox, reply] = await Promise.all([
          prisma.message.findFirst({
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, role: 'BUYER', contentJson: { path: ['text'], equals: '你好！' } },
            select: { id: true, sequence: true },
          }),
          prisma.replyJob.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id }, select: { id: true, status: true, sourceLastMessageId: true, sourceSequence: true } }),
          prisma.task.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, intent: 'SAFE_SOCIAL_GREETING' }, select: { id: true, intent: true } }),
          prisma.sendOutbox.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, status: 'SENT' }, select: { id: true, replyJobId: true, status: true } }),
          prisma.message.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, role: 'ASSISTANT', contentJson: { path: ['text'], string_contains: '您好，我在的' } }, select: { id: true } }),
        ]);
        return buyer && job && task && outbox && reply ? { conversationId: conversation.id, buyer, job, task, outbox } : undefined;
      });

      expect(completed.job).toMatchObject({
        status: 'SENT',
        sourceLastMessageId: completed.buyer.id,
        sourceSequence: completed.buyer.sequence,
      });
      expect(completed.outbox).toMatchObject({ status: 'SENT', replyJobId: completed.job.id });
      await expect(prisma.replyEvidence.count({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, replyJobId: completed.job.id } })).resolves.toBe(0);
      const evidenceTrace = await waitFor(async () => (await prisma.traceEvent.findFirst({
        where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, conversationId: completed.conversationId, stage: 'EVIDENCE' },
        orderBy: { createdAt: 'desc' },
        select: { payloadJson: true },
      })) ?? undefined);
      expect(evidenceTrace.payloadJson).toMatchObject({ evidenceCount: 0 });
      const safeReplyTrace = await waitFor(async () => (await prisma.traceEvent.findFirst({
        where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, conversationId: completed.conversationId, stage: 'BUILT_IN_SAFE_REPLY' },
        select: { id: true },
      })) ?? undefined);
      expect(safeReplyTrace).toMatchObject({ id: expect.any(String) });
      await waitFor(async () => events.some((event) => event.workspaceId === scope.workspaceId && event.eventType === 'CONVERSATION_UPDATED') ? true : undefined);
    } finally {
      socket.disconnect();
    }
  }, 60_000);

  it('SC06 creates zero AI Job/Draft/Outbox while off and only binds a new job to the future message after re-enable', async () => {
    const scope = await createScope();
    const socket = await connect(scope.token);
    const events: Array<{ eventType?: string; workspaceId?: string }> = [];
    socket.on('workspace.event', (event) => events.push(event));
    try {
      // Match runShowcaseScenario: establish SC06's AUTO_ALLOWED baseline,
      // then execute its explicit off-period transition.
      await setShopAiMode(scope, 'AUTO_ALLOWED');
      await setShopAiMode(scope, 'MANUAL_ONLY');
      await sendBuyerText(scope, '关闭期间的消息不应在重新开启后被补处理。');

      const offPeriod = await waitFor(async () => {
        const conversation = await prisma.conversation.findFirst({
          where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, buyerId: scope.buyerId },
          select: { id: true },
        });
        if (!conversation) return undefined;
        const [buyer, turn] = await Promise.all([
          prisma.message.findFirst({
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, role: 'BUYER', contentJson: { path: ['text'], equals: '关闭期间的消息不应在重新开启后被补处理。' } },
            select: { id: true, sequence: true },
          }),
          prisma.userTurn.findFirst({
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: conversation.id, normalizedText: '关闭期间的消息不应在重新开启后被补处理。' },
            select: { id: true },
          }),
        ]);
        if (!buyer || !turn) return undefined;
        const receipt = await prisma.processingReceipt.findFirst({
          where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, eventId: `reply-plan:${turn.id}` },
          select: { id: true },
        });
        return receipt ? { conversationId: conversation.id, buyer } : undefined;
      });
      await expect(aiArtifactCounts(scope, offPeriod.conversationId)).resolves.toEqual({ jobs: 0, drafts: 0, outboxes: 0, replies: 0 });

      await setShopAiMode(scope, 'AUTO_ALLOWED');
      await pause(1_000);
      await expect(aiArtifactCounts(scope, offPeriod.conversationId)).resolves.toEqual({ jobs: 0, drafts: 0, outboxes: 0, replies: 0 });

      await sendBuyerText(scope, '你好！');
      const future = await waitFor(async () => {
        const buyer = await prisma.message.findFirst({
          where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: offPeriod.conversationId, role: 'BUYER', contentJson: { path: ['text'], equals: '你好！' } },
          select: { id: true, sequence: true },
        });
        if (!buyer) return undefined;
        const [job, outbox, reply] = await Promise.all([
          prisma.replyJob.findFirst({
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: offPeriod.conversationId, sourceLastMessageId: buyer.id, status: 'SENT' },
            select: { id: true, sourceLastMessageId: true, sourceSequence: true, status: true },
          }),
          prisma.sendOutbox.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: offPeriod.conversationId, status: 'SENT' }, select: { id: true, replyJobId: true } }),
          prisma.message.findFirst({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: offPeriod.conversationId, role: 'ASSISTANT', contentJson: { path: ['text'], string_contains: '您好，我在的' } }, select: { id: true, sequence: true } }),
        ]);
        return job && outbox && reply ? { buyer, job, outbox, reply } : undefined;
      });
      expect(future.job).toMatchObject({ sourceLastMessageId: future.buyer.id, sourceSequence: future.buyer.sequence, status: 'SENT' });
      expect(future.outbox.replyJobId).toBe(future.job.id);
      expect(future.reply.sequence).toBeGreaterThan(future.buyer.sequence);
      expect(future.buyer.sequence).toBeGreaterThan(offPeriod.buyer.sequence);
      await expect(aiArtifactCounts(scope, offPeriod.conversationId)).resolves.toEqual({ jobs: 1, drafts: 0, outboxes: 1, replies: 1 });
      await waitFor(async () => events.some((event) => event.workspaceId === scope.workspaceId && event.eventType === 'CONVERSATION_UPDATED') ? true : undefined);
    } finally {
      socket.disconnect();
    }
  }, 75_000);

  async function createScope(): Promise<ShowcaseScope> {
    const created = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body as { token: string; workspace: { id: string } };
    workspaceIds.push(created.workspace.id);
    const header = { 'X-Demo-Workspace-Token': created.token };
    const shops = (await request(app.getHttpServer()).get('/api/shops').set(header).expect(200)).body as Array<{ id: string; name: string }>;
    const shop = shops.find((entry) => entry.name === 'MIA Fashion');
    if (!shop) throw new Error('SHOWCASE_TEST_SHOP_MISSING');
    const buyers = (await request(app.getHttpServer()).get('/api/buyers').query({ shopId: shop.id }).set(header).expect(200)).body as Array<{ id: string }>;
    if (!buyers[0]?.id) throw new Error('SHOWCASE_TEST_BUYER_MISSING');
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { workspaceId: created.workspace.id }, select: { id: true } });
    return { token: created.token, header, workspaceId: created.workspace.id, tenantId: tenant.id, shopId: shop.id, buyerId: buyers[0].id };
  }

  async function connect(token: string): Promise<Socket> {
    const socket = io(baseUrl, { path: '/ws', transports: ['websocket'], auth: { token }, reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  async function sendBuyerText(scope: ShowcaseScope, text: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/buyer/messages')
      .set(scope.header)
      .send({ shopId: scope.shopId, buyerId: scope.buyerId, kind: 'TEXT', text })
      .expect(202);
  }

  async function setShopAiMode(scope: ShowcaseScope, mode: 'AUTO_ALLOWED' | 'MANUAL_ONLY'): Promise<void> {
    await request(app.getHttpServer())
      .patch(`/api/shops/${scope.shopId}/ai-mode`)
      .set(scope.header)
      .send({ mode })
      .expect(200);
  }
});

async function aiArtifactCounts(scope: Pick<ShowcaseScope, 'workspaceId' | 'tenantId' | 'shopId'>, conversationId: string) {
  const prisma = livePrisma;
  if (!prisma) throw new Error('SHOWCASE_TEST_PRISMA_MISSING');
  const where = { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId };
  const [jobs, drafts, outboxes, replies] = await Promise.all([
    prisma.replyJob.count({ where }),
    prisma.replyDraft.count({
      where: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: scope.shopId,
        replyJob: { conversationId },
      },
    }),
    prisma.sendOutbox.count({ where }),
    prisma.message.count({ where: { ...where, role: 'ASSISTANT' } }),
  ]);
  return { jobs, drafts, outboxes, replies };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await pause(150);
  }
  throw new Error('SHOWCASE_REAL_INFRA_TIMEOUT');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
