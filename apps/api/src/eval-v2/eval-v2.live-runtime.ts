import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { AppModule } from '../app.module';
import { AttachmentService } from '../attachments/attachments.service';
import { PrismaService } from '../database/prisma.service';
import { PrismaWorkspaceRepository } from '../database/prisma-workspace.repository';
import { AiEvalFaultRegistry } from '../eval/ai-eval-fault-registry';
import { PrismaProductionReplyEvalPort, ProductionReplyEvalExecutor } from '../eval/production-reply-eval-executor';
import { ContextInvalidationService } from '../replies/context-invalidation.service';
import { ConversationReplyControlService } from '../replies/conversation-reply-control.service';
import { ReplyDraftService } from '../replies/reply-draft.service';
import { ReplyRecoveryService } from '../replies/reply-recovery.service';
import { SendOutboxService } from '../replies/send-outbox.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MESSAGE_APPLICATION, type MessageApplication } from '../messages/message.application';
import { SeedCatalog } from '../seed/seed-catalog';
import { WorkspaceService } from '../workspaces/workspace.service';
import { WorkflowProposalService } from '../workflow/workflow-proposal.service';
import { loadEvalV2Sources } from './eval-v2.loader';
import { writeEvalV2ReportAtomically } from './eval-v2.reporter';
import { ProductEvalExecutor, ProductionProductEvalPort } from './product-eval.executor';
import { RetrievalEvalExecutor, type ResolvedEvalEvidence, type RetrievalEvalFixture, type RetrievalEvalPort } from './retrieval-eval.executor';
import type { EvalProviderMode, ProductEvalCaseV2, RetrievalEvalCaseV2 } from './eval-v2.types';
import type { EvalV2CliRuntime } from './eval-v2.cli';

/** Builds the exact services used by the real integration suites, not a fixture-only substitute. */
const AI_PROVIDER_ENVIRONMENT_KEYS = [
  'AI_PROVIDER', 'AI_API_STYLE', 'AI_BASE_URL', 'AI_API_KEY', 'AI_API_KEY_FILE',
  'AI_FAST_MODEL', 'AI_QUALITY_MODEL', 'AI_MULTIMODAL_MODEL', 'AI_JUDGE_MODEL',
  'AI_MODEL_GATEWAY_URL', 'AI_MODEL_GATEWAY_SECRET', 'AI_MODEL_NAME',
] as const;

export async function createLiveEvalV2CliRuntime(
  repoRoot = resolve(__dirname, '../../../..'),
  mode: EvalProviderMode = 'OFFLINE_FIXTURE',
): Promise<EvalV2CliRuntime> {
  const savedEnvironment = new Map<string, string | undefined>();
  if (mode === 'OFFLINE_FIXTURE') {
    for (const key of AI_PROVIDER_ENVIRONMENT_KEYS) {
      savedEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    savedEnvironment.set('AI_OFFLINE_MODE', process.env.AI_OFFLINE_MODE);
    process.env.AI_OFFLINE_MODE = '1';
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const seeds = app.get(SeedCatalog);
  const retrieval = new RetrievalEvalExecutor(new PrismaRetrievalPort(
    prisma, seeds, new PrismaWorkspaceRepository(prisma), app.get(KnowledgeService),
  ));
  const product = new ProductEvalExecutor(new ProductionProductEvalPort(new ProductionReplyEvalExecutor(
    new PrismaProductionReplyEvalPort(
      app.get(WorkspaceService), app.get<MessageApplication>(MESSAGE_APPLICATION), prisma,
      { timeoutMs: 45_000, pollMs: 100 }, app.get(AttachmentService), app.get(KnowledgeService),
      app.get(ContextInvalidationService), app.get(ConversationReplyControlService), app.get(ReplyDraftService),
      app.get(AiEvalFaultRegistry), app.get(WorkflowProposalService), app.get(ReplyRecoveryService), app.get(SendOutboxService),
    ),
  )));
  return {
    canonical: () => ({ retrieval: readCanonical(repoRoot, 'retrieval-40.v2.json'), product: readCanonical(repoRoot, 'product-testset-72.v2.json') }),
    canonicalHashes: () => ({
      retrieval: hashFile(resolve(repoRoot, 'evals/canonical/retrieval-40.v2.json')),
      product: hashFile(resolve(repoRoot, 'evals/canonical/product-testset-72.v2.json')),
    }),
    currentSourceHashes: () => sourceHashes(repoRoot),
    executeRetrieval: (cases: readonly RetrievalEvalCaseV2[], mode: EvalProviderMode) => retrieval.run(cases, mode),
    executeProduct: (cases: readonly ProductEvalCaseV2[], mode: EvalProviderMode) => product.run(cases, mode),
    writeReport: (input) => writeEvalV2ReportAtomically(input, resolve(repoRoot, 'artifacts/eval-v2')),
    metadata: (input) => ({
      startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)), providerMode: input.mode,
      providerName: input.mode === 'OFFLINE_FIXTURE' ? 'offline-structured-demo' : (process.env.AI_PROVIDER ?? 'unconfigured'),
      model: process.env.AI_MODEL_NAME ?? (input.mode === 'OFFLINE_FIXTURE' ? 'offline-structured-v1' : 'configured-model'),
      git: gitMetadata(repoRoot),
      environment: { node: process.version, pnpm: process.env.npm_package_manager ?? 'unknown', os: process.platform },
      sourceHashes: input.sourceHashes, canonicalHashes: input.canonicalHashes,
      commands: [{ command: `eval:v2:${input.mode === 'OFFLINE_FIXTURE' ? 'offline' : 'real'}`, exitCode: input.exitCode, durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)) }],
    }),
    realEnvironmentAvailable: () => configuredRealProviderEnvironment(),
    environmentAvailable: (providerMode) => Boolean(
      process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT
      && (providerMode === 'OFFLINE_FIXTURE' || configuredRealProviderEnvironment()),
    ),
    close: async () => {
      await app.close();
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

class PrismaRetrievalPort implements RetrievalEvalPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seeds: SeedCatalog,
    private readonly repository: PrismaWorkspaceRepository,
    private readonly knowledge: KnowledgeService,
  ) {}

  async createIsolatedWorkspace(): Promise<RetrievalEvalFixture> {
    const created = await this.repository.createWithSeed({
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'), now: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000), seed: await this.seeds.load(), profile: 'SEEDED',
    });
    const scope = { workspaceId: created.workspaceId, tenantId: created.tenantId };
    const [shops, products] = await Promise.all([
      this.prisma.shop.findMany({ where: scope, select: { id: true, seedKey: true } }),
      this.prisma.product.findMany({ where: scope, select: { id: true, seedKey: true } }),
    ]);
    return { ...scope, shopIdsByKey: Object.fromEntries(shops.map((entry) => [entry.seedKey, entry.id])), productIdsByKey: Object.fromEntries(products.map((entry) => [entry.seedKey, entry.id])) };
  }

  async activateConflict(input: { workspaceId: string; tenantId: string; shopId: string; fixtureKey: string }): Promise<void> {
    if (input.fixtureKey !== 'conflict_001') throw new Error(`CONFLICT_FIXTURE_UNSUPPORTED:${input.fixtureKey}`);
    const scope = { workspaceId: input.workspaceId, tenantId: input.tenantId };
    await this.knowledge.create(scope, { shopId: input.shopId, scope: 'STORE', question: '普通商品多久发货？', answer: '普通现货商品通常24小时内发出。' });
    await this.knowledge.create(scope, { shopId: input.shopId, scope: 'STORE', question: '普通商品多久发货？', answer: '普通商品通常48小时内发出。' });
  }

  search(input: Parameters<RetrievalEvalPort['search']>[0]) {
    return this.knowledge.search({ workspaceId: input.workspaceId, tenantId: input.tenantId }, { shopId: input.shopId, query: input.query, ...(input.productId ? { productId: input.productId } : {}), ...(input.scope ? { scope: input.scope } : {}), topK: input.topK });
  }

  async resolveEvidence(input: { workspaceId: string; tenantId: string; shopId: string; evidence: ReplyEvidenceSnapshot[] }): Promise<ResolvedEvalEvidence[]> {
    const versions = await this.prisma.knowledgeVersion.findMany({
      where: { id: { in: input.evidence.map(({ versionId }) => versionId) }, workspaceId: input.workspaceId, tenantId: input.tenantId, item: { shopId: input.shopId } },
      include: { item: { include: { shop: { select: { seedKey: true } }, product: { select: { seedKey: true } } } } },
    });
    const byId = new Map(versions.map((entry) => [entry.id, entry]));
    return input.evidence.map((snapshot) => {
      const version = byId.get(snapshot.versionId);
      if (!version) throw new Error(`EVIDENCE_VERSION_SCOPE_MISMATCH:${snapshot.versionId}`);
      return { itemId: snapshot.itemId, versionId: snapshot.versionId, workspaceId: version.workspaceId, tenantId: version.tenantId, knowledgeKey: version.item.seedKey, shopKey: version.item.shop.seedKey, productKey: version.item.product?.seedKey ?? null, scope: snapshot.scope, score: snapshot.retrievalScore, contentSnapshot: { ...snapshot.contentSnapshot } };
    });
  }

  async deleteIsolatedWorkspace(workspaceId: string): Promise<void> { await this.prisma.workspace.deleteMany({ where: { id: workspaceId } }); }
}

function readCanonical(repoRoot: string, name: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, 'evals/canonical', name), 'utf8')) as { source: { sha256: string }; cases: never[] };
}
function sourceHashes(repoRoot: string) {
  const source = loadEvalV2Sources(repoRoot);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  return { retrieval: hash(source.paths.retrieval), product: hash(source.paths.product) };
}

function hashFile(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function gitMetadata(repoRoot: string): { commit: string; dirty: boolean } {
  try {
    return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0 };
  } catch { return { commit: process.env.GITHUB_SHA ?? 'unknown', dirty: true }; }
}

function configuredRealProviderEnvironment(): boolean {
  const provider = Boolean(process.env.AI_PROVIDER?.trim()) && process.env.AI_OFFLINE_MODE !== '1';
  const credential = Boolean(process.env.AI_API_KEY?.trim() || process.env.AI_API_KEY_FILE?.trim() || process.env.AI_MODEL_GATEWAY_SECRET?.trim());
  return Boolean(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT && provider && credential);
}
