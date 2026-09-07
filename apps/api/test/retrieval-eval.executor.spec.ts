import { resolve } from 'node:path';
import { compileEvalV2FromRepo } from '../src/eval-v2/eval-v2.converter';
import {
  RetrievalEvalExecutor,
  type ResolvedEvalEvidence,
  type RetrievalEvalFixture,
  type RetrievalEvalPort,
} from '../src/eval-v2/retrieval-eval.executor';

const repoRoot = resolve(__dirname, '../../..');
const cases = compileEvalV2FromRepo(repoRoot).retrieval.cases;
const fixture: RetrievalEvalFixture = {
  workspaceId: 'workspace-a',
  tenantId: 'tenant-a',
  shopIdsByKey: { shop_mia_fashion: 'shop-mia', shop_pixel_tech: 'shop-pixel' },
  productIdsByKey: { fashion_hoodie: 'product-hoodie', tech_silent_keyboard: 'product-keyboard', tech_monitor: 'product-monitor' },
};

describe('RetrievalEvalExecutor', () => {
  it('runs isolated workspace cases sequentially to stay within the shared database pool', async () => {
    let active = 0;
    let maximumActive = 0;
    const port = makePort({ search: { status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }, resolved: [] });
    port.createIsolatedWorkspace.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      return fixture;
    });
    port.deleteIsolatedWorkspace.mockImplementation(async () => {
      active -= 1;
    });
    const negative = caseById('Q21');

    const results = await new RetrievalEvalExecutor(port).run([negative, negative], 'OFFLINE_FIXTURE');

    expect(results).toHaveLength(2);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
  });

  it('passes a positive case only when an expected frozen version is within max rank', async () => {
    const port = makePort({
      search: evidenceResult('item-decoy', 'version-decoy', 'item-good', 'version-good'),
      resolved: [
        evidence('item-decoy', 'version-decoy', 'k035', 'shop_mia_fashion', 'fashion_hoodie'),
        evidence('item-good', 'version-good', 'k033', 'shop_mia_fashion', 'fashion_hoodie'),
      ],
    });

    const result = await new RetrievalEvalExecutor(port).execute(caseById('Q05'), 'OFFLINE_FIXTURE');

    expect(result.status).toBe('PASS');
    expect(result.actual.evidence.map((entry) => entry.knowledgeKey)).toEqual(['k035', 'k033']);
    expect(port.deleteIsolatedWorkspace).toHaveBeenCalledWith('workspace-a');
  });

  it('fails when evidence belongs to another product even if the answer text is plausible', async () => {
    const port = makePort({
      search: evidenceResult('item-wrong', 'version-wrong'),
      resolved: [evidence('item-wrong', 'version-wrong', 'k052', 'shop_mia_fashion', 'fashion_cardigan')],
    });

    const result = await new RetrievalEvalExecutor(port).execute(caseById('Q05'), 'OFFLINE_FIXTURE');

    expect(result.status).toBe('FAIL');
    expect(result.failureReasons).toContain('EXPECTED_KNOWLEDGE_NOT_IN_TOP_3');
    expect(result.failureReasons).toContain('FORBIDDEN_KNOWLEDGE:k052');
    expect(result.failureReasons).toContain('FORBIDDEN_PRODUCT:fashion_cardigan');
    expect(result.failureReasons).toContain('EVIDENCE_PRODUCT_MISMATCH:fashion_cardigan');
  });

  it('passes a negative case only with an allowed no-evidence status and no evidence rows', async () => {
    const port = makePort({ search: { status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }, resolved: [] });
    await expect(new RetrievalEvalExecutor(port).execute(caseById('Q21'), 'OFFLINE_FIXTURE')).resolves.toMatchObject({
      status: 'PASS',
      failureReasons: [],
    });

    port.search.mockResolvedValue(evidenceResult('item-unexpected', 'version-unexpected'));
    port.resolveEvidence.mockResolvedValue([evidence('item-unexpected', 'version-unexpected', 'k007', 'shop_mia_fashion', null, 'STORE')]);
    const failed = await new RetrievalEvalExecutor(port).execute(caseById('Q21'), 'OFFLINE_FIXTURE');
    expect(failed.status).toBe('FAIL');
    expect(failed.failureReasons).toContain('NEGATIVE_EVIDENCE_RETURNED');
  });

  it('passes Q37 only when the conflict fixture produces CONFLICTED with no evidence', async () => {
    const port = makePort({ search: { status: 'CONFLICTED', evidence: [], conflictItemIds: ['left', 'right'] }, resolved: [] });

    const result = await new RetrievalEvalExecutor(port).execute(caseById('Q37'), 'OFFLINE_FIXTURE');

    expect(result.status).toBe('PASS');
    expect(port.activateConflict).toHaveBeenCalledWith({
      workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-mia', fixtureKey: 'conflict_001',
    });
  });

  it('records execution errors as failures and still removes the isolated workspace', async () => {
    const port = makePort({ search: { status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }, resolved: [] });
    port.search.mockRejectedValue(new Error('database unavailable'));

    const result = await new RetrievalEvalExecutor(port).execute(caseById('Q01'), 'OFFLINE_FIXTURE');

    expect(result.status).toBe('FAIL');
    expect(result.failureReasons).toEqual(['EXECUTION_ERROR:database unavailable']);
    expect(port.deleteIsolatedWorkspace).toHaveBeenCalledWith('workspace-a');
  });
});

function caseById(id: string) {
  const value = cases.find((entry) => entry.id === id);
  if (!value) throw new Error(`Missing fixture ${id}`);
  return value;
}

function evidence(
  itemId: string,
  versionId: string,
  knowledgeKey: string,
  shopKey: string,
  productKey: string | null,
  scope: 'STORE' | 'PRODUCT' = 'PRODUCT',
): ResolvedEvalEvidence {
  return {
    itemId,
    versionId,
    workspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    knowledgeKey,
    shopKey,
    productKey,
    scope,
    score: 0.91,
    contentSnapshot: { question: 'fixture', answer: 'fixture answer' },
  };
}

function evidenceResult(...ids: string[]) {
  const pairs = Array.from({ length: ids.length / 2 }, (_, index) => ({
    itemId: ids[index * 2]!, versionId: ids[index * 2 + 1]!, version: 1, source: 'MANUAL' as const,
    scope: 'PRODUCT' as const, productId: 'product-hoodie', contentSnapshot: { question: 'fixture', answer: 'fixture answer' }, retrievalScore: 0.91,
  }));
  return { status: 'EVIDENCE' as const, evidence: pairs, conflictItemIds: [] };
}

function makePort(input: { search: Awaited<ReturnType<RetrievalEvalPort['search']>>; resolved: ResolvedEvalEvidence[] }): jest.Mocked<RetrievalEvalPort> {
  return {
    createIsolatedWorkspace: jest.fn().mockResolvedValue(fixture),
    activateConflict: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue(input.search),
    resolveEvidence: jest.fn().mockResolvedValue(input.resolved),
    deleteIsolatedWorkspace: jest.fn().mockResolvedValue(undefined),
  };
}
