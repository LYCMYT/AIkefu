import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  PrismaProductionReplyEvalPort,
  ProductionReplyEvalExecutor,
} from '../src/eval/production-reply-eval-executor';
import { MESSAGE_APPLICATION, type MessageApplication } from '../src/messages/message.application';
import { WorkspaceService } from '../src/workspaces/workspace.service';
import { AttachmentService } from '../src/attachments/attachments.service';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { ContextInvalidationService } from '../src/replies/context-invalidation.service';
import { ConversationReplyControlService } from '../src/replies/conversation-reply-control.service';
import { ReplyDraftService } from '../src/replies/reply-draft.service';

const runRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const aiEnvironmentKeys = [
  'AI_PROVIDER', 'AI_API_STYLE', 'AI_BASE_URL', 'AI_API_KEY', 'AI_API_KEY_FILE',
  'AI_FAST_MODEL', 'AI_QUALITY_MODEL', 'AI_MULTIMODAL_MODEL', 'AI_JUDGE_MODEL',
  'AI_MODEL_GATEWAY_URL', 'AI_MODEL_GATEWAY_SECRET', 'AI_MODEL_NAME',
] as const;

(runRealInfra ? describe : describe.skip)('Production reply eval real infrastructure', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const savedAiEnvironment = new Map<string, string>();

  beforeAll(async () => {
    for (const key of aiEnvironmentKeys) {
      if (process.env[key] !== undefined) savedAiEnvironment.set(key, process.env[key]!);
      delete process.env[key];
    }
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  }, 30_000);

  afterAll(async () => {
    await moduleRef?.close();
    for (const key of aiEnvironmentKeys) {
      const value = savedAiEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runs E001 through the durable production chain and removes its exact workspace', async () => {
    const before = new Set((await prisma.workspace.findMany({ select: { id: true } })).map((entry) => entry.id));
    const port = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 30_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
    );
    const executor = new ProductionReplyEvalExecutor(port);

    const result = await executor.execute({
      id: 'E001', category: 'STORE_FAQ', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001',
      messages: ['多久发货？'], contextSetup: {}, expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'ASSIST',
      expectedFacts: ['普通现货商品通常在24小时内发出'], forbiddenClaims: ['保证24小时到达'],
    });

    expect(result).toMatchObject({
      tasks: ['SHIPPING_POLICY'], mode: 'ASSIST', outputSource: 'DRAFT', terminalStatus: 'WAITING_HUMAN',
    });
    expect(result.text).toContain('普通现货商品通常在24小时内发出');
    expect(result.evidence).toContain('普通现货商品通常在24小时内发出；预售商品以商品说明为准。');
    expect(result.trace?.knowledgeVersionIds.length).toBeGreaterThanOrEqual(1);
    const after = await prisma.workspace.findMany({ select: { id: true } });
    expect(after.every((entry) => before.has(entry.id))).toBe(true);
  }, 45_000);

  it('commits a product card before the text turn so product Evidence is selected', async () => {
    const port = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 30_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
    );
    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: 'E004', category: 'PRODUCT_KNOWLEDGE', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      messages: [{ type: 'GOODS_CARD', productKey: 'fashion_hoodie' }, '这个可以烘干吗？'], contextSetup: {},
      expectedTasks: ['PRODUCT_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['不建议使用烘干机'], forbiddenClaims: ['可以高温烘干'],
    });

    expect(result.tasks).toContain('PRODUCT_QUERY');
    expect(result.text).toContain('不建议使用烘干机');
    expect(result.evidence.some((answer) => answer.includes('不建议使用烘干机'))).toBe(true);
    expect(result.trace?.knowledgeVersionIds.length).toBeGreaterThanOrEqual(1);
  }, 45_000);

  it('recalls the previous buyer message before planning the corrected follow-up', async () => {
    const port = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 30_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
    );
    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: 'E022', category: 'MESSAGE_RECALL', shopKey: 'shop_pixel_tech', buyerKey: 'buyer_001',
      messages: ['我要退款', { action: 'RECALL_PREVIOUS' }, '发错了，我想问物流'], contextSetup: {},
      expectedTasks: ['LOGISTICS_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: ['继续退款流程'],
    });

    expect(result.tasks).toContain('LOGISTICS_QUERY');
    expect(result.tasks).not.toContain('REFUND_REQUEST');
    expect(result.mode).toBe('ASSIST');
  }, 45_000);

  it('replans the affected durable turn after a buyer edits the previous text', async () => {
    const port = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 30_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
    );
    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: 'E023', category: 'MESSAGE_EDIT', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      messages: ['黑色XL有吗', { action: 'EDIT_PREVIOUS', text: '白色L有吗' }], contextSetup: {},
      expectedTasks: ['INVENTORY_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['有现货'], forbiddenClaims: ['回答黑色XL'],
    });

    expect(result.tasks).toContain('INVENTORY_QUERY');
    expect(result.text).toContain('有现货');
    expect(result.text).not.toContain('黑色XL');
  }, 45_000);

  it.each([
    {
      id: 'E020', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_004', fixture: 'damaged_sleeve.png', followUp: '收到就是这样的',
      task: 'AFTER_SALES_QUERY', fact: '疑似商品破损', forbidden: '已经自动退款',
    },
    {
      id: 'E021', shopKey: 'shop_pixel_tech', buyerKey: 'buyer_003', fixture: 'shipping_label.png', followUp: '帮我看看这个',
      task: 'ORDER_QUERY', fact: '', forbidden: '13800138000',
    },
  ])('runs $id through real attachment analysis without exposing image PII', async (testCase) => {
    const port = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 30_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
    );
    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: testCase.id, shopKey: testCase.shopKey, buyerKey: testCase.buyerKey,
      messages: [{ type: 'IMAGE', fixture: testCase.fixture }, testCase.followUp], contextSetup: {},
      expectedTasks: [testCase.task], expectedMode: 'ASSIST', expectedFacts: testCase.fact ? [testCase.fact] : [], forbiddenClaims: [testCase.forbidden],
    });

    expect(result.tasks).toContain(testCase.task);
    expect(result.mode).toBe('ASSIST');
    if (testCase.fact) expect(result.text).toContain(testCase.fact);
    expect(result.text).not.toContain(testCase.forbidden);
  }, 45_000);
});
