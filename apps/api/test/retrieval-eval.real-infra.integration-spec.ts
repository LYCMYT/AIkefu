import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';
import { SeedCatalog } from '../src/seed/seed-catalog';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { compileEvalV2FromRepo } from '../src/eval-v2/eval-v2.converter';
import {
  RetrievalEvalExecutor,
  type ResolvedEvalEvidence,
  type RetrievalEvalFixture,
  type RetrievalEvalPort,
} from '../src/eval-v2/retrieval-eval.executor';

const describeReal = process.env.RUN_REAL_INFRA_INTEGRATION === '1' ? describe : describe.skip;
const repoRoot = resolve(__dirname, '../../..');

describeReal('Eval V2 retrieval against real PostgreSQL and pgvector', () => {
  jest.setTimeout(240_000);
  const prisma = new PrismaService();
  const seeds = new SeedCatalog();
  const repository = new PrismaWorkspaceRepository(prisma);
  const knowledge = new KnowledgeService(prisma, seeds);

  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it('executes all 40 source IDs without cross-workspace, cross-shop, or cross-product evidence', async () => {
    const port = new PrismaRetrievalEvalPort(prisma, seeds, repository, knowledge);
    const executor = new RetrievalEvalExecutor(port);
    const cases = compileEvalV2FromRepo(repoRoot).retrieval.cases;
    const results = [];
    for (const testCase of cases) results.push(await executor.execute(testCase, 'OFFLINE_FIXTURE'));

    expect(results).toHaveLength(40);
    expect(new Set(results.map(({ id }) => id)).size).toBe(40);
    expect(results.filter(({ status }) => status !== 'PASS').map(({ id, failureReasons }) => ({ id, failureReasons }))).toEqual([]);
    await expect(prisma.workspace.count({ where: { id: { in: port.createdWorkspaceIds } } })).resolves.toBe(0);
  });
});

class PrismaRetrievalEvalPort implements RetrievalEvalPort {
  readonly createdWorkspaceIds: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly seeds: SeedCatalog,
    private readonly repository: PrismaWorkspaceRepository,
    private readonly knowledge: KnowledgeService,
  ) {}

  async createIsolatedWorkspace(): Promise<RetrievalEvalFixture> {
    const seed = await this.seeds.load();
    const created = await this.repository.createWithSeed({
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      now: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      seed,
      profile: 'SEEDED',
    });
    this.createdWorkspaceIds.push(created.workspaceId);
    const scope = { workspaceId: created.workspaceId, tenantId: created.tenantId };
    const [shops, products] = await Promise.all([
      this.prisma.shop.findMany({ where: scope, select: { id: true, seedKey: true } }),
      this.prisma.product.findMany({ where: scope, select: { id: true, seedKey: true } }),
    ]);
    return {
      ...scope,
      shopIdsByKey: Object.fromEntries(shops.map((entry) => [entry.seedKey, entry.id])),
      productIdsByKey: Object.fromEntries(products.map((entry) => [entry.seedKey, entry.id])),
    };
  }

  async activateConflict(input: { workspaceId: string; tenantId: string; shopId: string; fixtureKey: string }): Promise<void> {
    if (input.fixtureKey !== 'conflict_001') throw new Error(`CONFLICT_FIXTURE_UNSUPPORTED:${input.fixtureKey}`);
    const scope = { workspaceId: input.workspaceId, tenantId: input.tenantId };
    await this.knowledge.create(scope, {
      shopId: input.shopId, scope: 'STORE', question: '普通商品多久发货？', answer: '普通现货商品通常24小时内发出。',
    });
    await this.knowledge.create(scope, {
      shopId: input.shopId, scope: 'STORE', question: '普通商品多久发货？', answer: '普通商品通常48小时内发出。',
    });
  }

  async search(input: Parameters<RetrievalEvalPort['search']>[0]) {
    return this.knowledge.search(
      { workspaceId: input.workspaceId, tenantId: input.tenantId },
      {
        shopId: input.shopId,
        query: input.query,
        ...(input.productId ? { productId: input.productId } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        topK: input.topK,
      },
    );
  }

  async resolveEvidence(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    evidence: ReplyEvidenceSnapshot[];
  }): Promise<ResolvedEvalEvidence[]> {
    const versions = await this.prisma.knowledgeVersion.findMany({
      where: {
        id: { in: input.evidence.map(({ versionId }) => versionId) },
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        item: { shopId: input.shopId },
      },
      include: {
        item: {
          include: {
            shop: { select: { seedKey: true } },
            product: { select: { seedKey: true } },
          },
        },
      },
    });
    const byId = new Map(versions.map((entry) => [entry.id, entry]));
    return input.evidence.map((snapshot) => {
      const version = byId.get(snapshot.versionId);
      if (!version) throw new Error(`EVIDENCE_VERSION_SCOPE_MISMATCH:${snapshot.versionId}`);
      return {
        itemId: snapshot.itemId,
        versionId: snapshot.versionId,
        workspaceId: version.workspaceId,
        tenantId: version.tenantId,
        knowledgeKey: version.item.seedKey,
        shopKey: version.item.shop.seedKey,
        productKey: version.item.product?.seedKey ?? null,
        scope: snapshot.scope,
        score: snapshot.retrievalScore,
        contentSnapshot: { ...snapshot.contentSnapshot },
      };
    });
  }

  async deleteIsolatedWorkspace(workspaceId: string): Promise<void> {
    await this.prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }
}
