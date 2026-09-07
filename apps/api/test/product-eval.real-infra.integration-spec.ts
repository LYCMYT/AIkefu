import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { MESSAGE_APPLICATION, type MessageApplication } from '../src/messages/message.application';
import { WorkspaceService } from '../src/workspaces/workspace.service';
import { AttachmentService } from '../src/attachments/attachments.service';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { ContextInvalidationService } from '../src/replies/context-invalidation.service';
import { ConversationReplyControlService } from '../src/replies/conversation-reply-control.service';
import { ReplyDraftService } from '../src/replies/reply-draft.service';
import { AiEvalFaultRegistry } from '../src/eval/ai-eval-fault-registry';
import { WorkflowProposalService } from '../src/workflow/workflow-proposal.service';
import { ReplyRecoveryService } from '../src/replies/reply-recovery.service';
import { SendOutboxService } from '../src/replies/send-outbox.service';
import {
  PrismaProductionReplyEvalPort,
  ProductionReplyEvalExecutor,
} from '../src/eval/production-reply-eval-executor';
import {
  ProductEvalExecutor,
  ProductionProductEvalPort,
} from '../src/eval-v2/product-eval.executor';
import type { ProductEvalCaseV2 } from '../src/eval-v2/eval-v2.types';

const runRealInfra = process.env.RUN_REAL_INFRA_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.REDIS_URL)
  && Boolean(process.env.S3_ENDPOINT);
const aiEnvironmentKeys = [
  'AI_PROVIDER', 'AI_API_STYLE', 'AI_BASE_URL', 'AI_API_KEY', 'AI_API_KEY_FILE',
  'AI_FAST_MODEL', 'AI_QUALITY_MODEL', 'AI_MULTIMODAL_MODEL', 'AI_JUDGE_MODEL',
  'AI_MODEL_GATEWAY_URL', 'AI_MODEL_GATEWAY_SECRET', 'AI_MODEL_NAME', 'AI_OFFLINE_MODE',
] as const;

(runRealInfra ? describe : describe.skip)('Product Eval V2 real infrastructure', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const savedAiEnvironment = new Map<string, string>();

  beforeAll(async () => {
    for (const key of aiEnvironmentKeys) {
      if (process.env[key] !== undefined) savedAiEnvironment.set(key, process.env[key]!);
      delete process.env[key];
    }
    process.env.AI_OFFLINE_MODE = '1';
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

  it('executes all 72 canonical cases with no unsupported capability or leaked workspace', async () => {
    const source = JSON.parse(readFileSync(
      resolve(__dirname, '../../../evals/canonical/product-testset-72.v2.json'),
      'utf8',
    )) as { cases: ProductEvalCaseV2[] };
    const requestedIds = new Set((process.env.EVAL_V2_CASE_IDS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean));
    const selectedCases = requestedIds.size
      ? source.cases.filter((entry) => requestedIds.has(entry.id))
      : source.cases;
    const missingIds = [...requestedIds].filter((id) => !selectedCases.some((entry) => entry.id === id));
    if (missingIds.length) throw new Error(`EVAL_V2_CASE_IDS_UNKNOWN:${missingIds.join(',')}`);
    const before = new Set((await prisma.workspace.findMany({ select: { id: true } })).map((entry) => entry.id));
    const legacyPort = new PrismaProductionReplyEvalPort(
      moduleRef.get(WorkspaceService),
      moduleRef.get<MessageApplication>(MESSAGE_APPLICATION),
      prisma,
      { timeoutMs: 45_000, pollMs: 100 },
      moduleRef.get(AttachmentService),
      moduleRef.get(KnowledgeService),
      moduleRef.get(ContextInvalidationService),
      moduleRef.get(ConversationReplyControlService),
      moduleRef.get(ReplyDraftService),
      moduleRef.get(AiEvalFaultRegistry),
      moduleRef.get(WorkflowProposalService),
      moduleRef.get(ReplyRecoveryService),
      moduleRef.get(SendOutboxService),
    );
    const executor = new ProductEvalExecutor(new ProductionProductEvalPort(
      new ProductionReplyEvalExecutor(legacyPort),
    ));

    const results = await executor.run(selectedCases, 'OFFLINE_FIXTURE');
    const blocked = results.filter((entry) => entry.status === 'BLOCKED_UNSUPPORTED');
    const notPassed = results.filter((entry) => entry.status !== 'PASS');
    const after = await prisma.workspace.findMany({ select: { id: true } });

    if (notPassed.length) process.stderr.write(`${notPassed.map((entry) => `${entry.id}:${entry.failureReasons.join(',')}`).join('\n')}\n`);
    if (notPassed.length && process.env.EVAL_V2_DEBUG_OBSERVATIONS === '1') {
      process.stderr.write(`${JSON.stringify(notPassed.map((entry) => ({
        id: entry.id,
        failureReasons: entry.failureReasons,
        observation: entry.observation,
      })), null, 2)}\n`);
    }
    expect(results).toHaveLength(selectedCases.length);
    expect(new Set(results.map((entry) => entry.id)).size).toBe(selectedCases.length);
    expect(blocked).toEqual([]);
    expect(notPassed.map((entry) => `${entry.id}:${entry.failureReasons.join(',')}`)).toEqual([]);
    expect(after.every((entry) => before.has(entry.id))).toBe(true);
  }, 20 * 60_000);
});
