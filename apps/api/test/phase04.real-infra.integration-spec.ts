import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaMessageApplication } from '../src/messages/prisma-message.application';
import { MockDouyinSendWorker } from '../src/replies/mock-douyin-send.worker';
import { ReplyJobService } from '../src/replies/reply-job.service';
import { SendOutboxService } from '../src/replies/send-outbox.service';

const describeRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1' && process.env.DATABASE_URL
  ? describe
  : describe.skip;

/**
 * Real PostgreSQL acceptance for Phase 04's durable boundaries. It is opt-in:
 * `RUN_REAL_INFRA_INTEGRATION=1 pnpm --filter @ai-customer-service/api test:integration`.
 * Default CI only discovers this suite as skipped; it never pretends a local
 * in-memory fake validates advisory locks or partial indexes.
 */
describeRealInfra('Phase 04 real PostgreSQL reliability boundaries', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workspaceId: string;
  let tenantId: string;
  let shopId: string;
  let buyerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    workspaceId = session.workspace.id;
    tenantId = (await prisma.tenant.findFirstOrThrow({ where: { workspaceId }, select: { id: true } })).id;
    shopId = (await prisma.shop.findFirstOrThrow({ where: { workspaceId, tenantId }, select: { id: true } })).id;
    buyerId = (await prisma.buyer.findFirstOrThrow({ where: { workspaceId, tenantId }, select: { id: true } })).id;
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await app?.close();
  });

  it('has the partial active ReplyJob constraint and durable transport-start column deployed', async () => {
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>("SELECT indexname FROM pg_indexes WHERE indexname = 'ReplyJob_one_active_per_conversation'");
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>("SELECT column_name FROM information_schema.columns WHERE table_name = 'SendOutbox' AND column_name = 'transportStartedAt'");
    expect(indexes).toEqual([{ indexname: 'ReplyJob_one_active_per_conversation' }]);
    expect(columns).toEqual([{ column_name: 'transportStartedAt' }]);
  });

  it('enforces one active job per scoped conversation and turns a crashed started transport UNCERTAIN without retrying', async () => {
    const scope = { workspaceId, tenantId, shopId };
    const conversation = await prisma.conversation.create({
      data: { ...scope, buyerId, externalConversationId: `real-phase04-${Date.now()}`, lastCommittedSequence: 1 },
    });
    const message = await prisma.message.create({
      data: { ...scope, buyerId, conversationId: conversation.id, platform: 'DOUYIN_DEMO', externalMessageId: `real-msg-${Date.now()}`, sequence: 1, role: 'BUYER', kind: 'TEXT', contentJson: { text: '库存还有吗' }, sentAt: new Date(), receivedAt: new Date() },
    });
    const turn = await prisma.userTurn.create({
      data: { ...scope, conversationId: conversation.id, sourceMessageIdsJson: [message.id], firstSequence: 1, lastSequence: 1, normalizedText: '库存还有吗', turnKey: `real-turn-${conversation.id}` },
    });
    const job = await prisma.replyJob.create({
      data: { ...scope, conversationId: conversation.id, userTurnId: turn.id, mode: 'AUTO', status: 'FAST_PATH_READY', sourceLastMessageId: message.id, sourceSequence: 1, sourceContextVersion: 1, idempotencyKey: `real-job-${conversation.id}` },
    });
    await expect(prisma.replyJob.create({
      data: { ...scope, conversationId: conversation.id, userTurnId: turn.id, mode: 'AUTO', status: 'PENDING', sourceLastMessageId: message.id, sourceSequence: 1, sourceContextVersion: 1, idempotencyKey: `real-duplicate-${conversation.id}` },
    })).rejects.toMatchObject({ code: 'P2002' });
    const outbox = await prisma.sendOutbox.create({
      data: { ...scope, conversationId: conversation.id, replyJobId: job.id, idempotencyKey: `real-send-${conversation.id}`, payloadJson: { text: '当前库存为 0', senderRole: 'AI' }, expectedLastMessageId: message.id, expectedSequence: 1, expectedContextVersion: 1, status: 'SENDING', transportStartedAt: new Date(Date.now() - 60_000) },
    });
    await new SendOutboxService(prisma).recoverUncertain(new Date());
    await expect(prisma.sendOutbox.findFirstOrThrow({ where: { id: outbox.id }, select: { status: true } })).resolves.toEqual({ status: 'UNCERTAIN' });
  });

  it('consumes a scoped USER_TURN_READY exactly once into a durable ReplyJob and cannot read it from another shop', async () => {
    const scope = { workspaceId, tenantId, shopId };
    const otherShop = await prisma.shop.create({
      data: {
        workspaceId,
        tenantId,
        seedKey: `real-other-${Date.now()}`,
        platform: 'DOUYIN_DEMO',
        externalShopId: `real-other-${Date.now()}`,
        name: 'Real isolation shop',
        aiMode: 'ASSIST_ONLY',
        connectionState: 'CONNECTED',
      },
      select: { id: true },
    });
    const conversation = await prisma.conversation.create({
      data: { ...scope, buyerId, externalConversationId: `real-outbox-${Date.now()}`, lastCommittedSequence: 1, contextVersion: 1 },
    });
    const message = await prisma.message.create({
      data: {
        ...scope, buyerId, conversationId: conversation.id, platform: 'DOUYIN_DEMO',
        externalMessageId: `real-outbox-message-${Date.now()}`, sequence: 1, role: 'BUYER', kind: 'TEXT',
        contentJson: { text: '什么时候到货' }, sentAt: new Date(), receivedAt: new Date(),
      },
    });
    const turn = await prisma.userTurn.create({
      data: {
        ...scope, conversationId: conversation.id, sourceMessageIdsJson: [message.id], firstSequence: 1, lastSequence: 1,
        normalizedText: '什么时候到货', turnKey: `real-outbox-turn-${conversation.id}`,
      },
    });
    const eventId = `real-user-turn-${conversation.id}`;
    await prisma.processingOutbox.create({
      data: {
        ...scope, eventId, aggregateType: 'Conversation', aggregateId: conversation.id, eventType: 'USER_TURN_READY',
        payloadJson: {
          conversationId: conversation.id, userTurnId: turn.id, sourceLastMessageId: message.id,
          sourceSequence: 1, sourceContextVersion: 1,
        },
      },
    });

    // Exercise the production outbox consumer and ReplyJob service against
    // PostgreSQL, while deliberately omitting ReplyRuntime so this durable
    // boundary never makes a model/network call in the infra test.
    const application = new PrismaMessageApplication(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new ReplyJobService(prisma),
    );
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox(eventId);
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox(eventId);

    const jobs = await prisma.replyJob.findMany({ where: { ...scope, conversationId: conversation.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ userTurnId: turn.id, status: 'PENDING', idempotencyKey: eventId });
    await expect(prisma.processingReceipt.count({ where: { ...scope, eventId } })).resolves.toBe(1);
    await expect(new ReplyJobService(prisma).get({ workspaceId, tenantId, shopId: otherShop.id }, jobs[0]!.id)).resolves.toBeNull();
  });

  it('projects a confirmed AI receipt as the Prisma ASSISTANT enum, never the transport-only AI string', async () => {
    const scope = { workspaceId, tenantId, shopId };
    const conversation = await prisma.conversation.create({
      data: { ...scope, buyerId, externalConversationId: `real-projection-${Date.now()}`, lastCommittedSequence: 1 },
    });
    const source = await prisma.message.create({
      data: {
        ...scope, buyerId, conversationId: conversation.id, platform: 'DOUYIN_DEMO', externalMessageId: `real-projection-source-${Date.now()}`,
        sequence: 1, role: 'BUYER', kind: 'TEXT', contentJson: { text: '你好' }, sentAt: new Date(), receivedAt: new Date(),
      },
    });
    const send = await prisma.sendOutbox.create({
      data: {
        ...scope, conversationId: conversation.id, idempotencyKey: `real-projection-send-${conversation.id}`,
        payloadJson: { text: '您好，我来帮您查询。', senderRole: 'AI' }, expectedLastMessageId: source.id,
        expectedSequence: 1, expectedContextVersion: 1, status: 'SENT',
        receiptJson: { externalMessageId: `real-projection-receipt-${conversation.id}`, sentAt: new Date().toISOString() },
      },
    });
    const worker = new MockDouyinSendWorker(prisma, new SendOutboxService(prisma), {} as never);
    await expect(worker.recoverReceiptProjections()).resolves.toBeGreaterThanOrEqual(1);
    await expect(prisma.message.findFirstOrThrow({ where: { shopId, externalMessageId: `real-projection-receipt-${conversation.id}` }, select: { role: true } })).resolves.toEqual({ role: 'ASSISTANT' });
    await expect(prisma.sendOutbox.findFirstOrThrow({ where: { id: send.id }, select: { status: true } })).resolves.toEqual({ status: 'SENT' });
  });
});
