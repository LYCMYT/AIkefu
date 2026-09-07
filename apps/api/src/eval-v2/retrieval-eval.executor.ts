import type { KnowledgeRetrievalResult, ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import type { EvalCaseStatus, EvalProviderMode, RetrievalEvalCaseV2 } from './eval-v2.types';

export type RetrievalEvalFixture = {
  workspaceId: string;
  tenantId: string;
  shopIdsByKey: Record<string, string>;
  productIdsByKey: Record<string, string>;
};

export type ResolvedEvalEvidence = {
  itemId: string;
  versionId: string;
  workspaceId: string;
  tenantId: string;
  knowledgeKey: string;
  shopKey: string;
  productKey: string | null;
  scope: 'STORE' | 'PRODUCT';
  score: number;
  contentSnapshot: { question: string; answer: string };
};

export type RetrievalEvalPort = {
  createIsolatedWorkspace(): Promise<RetrievalEvalFixture>;
  activateConflict(input: { workspaceId: string; tenantId: string; shopId: string; fixtureKey: string }): Promise<void>;
  search(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    productId?: string;
    scope?: 'STORE' | 'PRODUCT';
    query: string;
    topK: number;
  }): Promise<KnowledgeRetrievalResult>;
  resolveEvidence(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    evidence: ReplyEvidenceSnapshot[];
  }): Promise<ResolvedEvalEvidence[]>;
  deleteIsolatedWorkspace(workspaceId: string): Promise<void>;
};

export type RetrievalEvalCaseResultV2 = {
  id: string;
  status: EvalCaseStatus;
  passed: boolean;
  providerMode: EvalProviderMode;
  durationMs: number;
  failureReasons: string[];
  actual: {
    retrievalStatus: KnowledgeRetrievalResult['status'] | 'EXECUTION_ERROR';
    evidence: ResolvedEvalEvidence[];
    conflictItemIds: string[];
  };
};

export class RetrievalEvalExecutor {
  constructor(private readonly port: RetrievalEvalPort) {}

  async run(
    cases: readonly RetrievalEvalCaseV2[],
    providerMode: EvalProviderMode,
  ): Promise<RetrievalEvalCaseResultV2[]> {
    const results: RetrievalEvalCaseResultV2[] = [];
    for (const testCase of cases) results.push(await this.execute(testCase, providerMode));
    return results;
  }

  async execute(testCase: RetrievalEvalCaseV2, providerMode: EvalProviderMode): Promise<RetrievalEvalCaseResultV2> {
    const startedAt = Date.now();
    let fixture: RetrievalEvalFixture | undefined;
    let retrievalStatus: RetrievalEvalCaseResultV2['actual']['retrievalStatus'] = 'EXECUTION_ERROR';
    let resolvedEvidence: ResolvedEvalEvidence[] = [];
    let conflictItemIds: string[] = [];
    const failureReasons: string[] = [];
    try {
      fixture = await this.port.createIsolatedWorkspace();
      const shopId = fixture.shopIdsByKey[testCase.shopKey];
      if (!shopId) throw new Error(`FIXTURE_SHOP_MISSING:${testCase.shopKey}`);
      const productId = testCase.productKey ? fixture.productIdsByKey[testCase.productKey] : undefined;
      if (testCase.productKey && !productId) throw new Error(`FIXTURE_PRODUCT_MISSING:${testCase.productKey}`);
      if (testCase.expectation.kind === 'CONFLICT') {
        await this.port.activateConflict({
          workspaceId: fixture.workspaceId,
          tenantId: fixture.tenantId,
          shopId,
          fixtureKey: testCase.expectation.conflictFixtureKey,
        });
      }
      const topK = testCase.expectation.kind === 'POSITIVE' ? testCase.expectation.maxRank : 3;
      const result = await this.port.search({
        workspaceId: fixture.workspaceId,
        tenantId: fixture.tenantId,
        shopId,
        ...(productId ? { productId } : {}),
        ...(testCase.expectation.kind === 'POSITIVE' ? { scope: testCase.expectation.expectedScope } : {}),
        query: testCase.query,
        topK,
      });
      retrievalStatus = result.status;
      conflictItemIds = [...result.conflictItemIds];
      if (result.evidence.length > 0) {
        resolvedEvidence = await this.port.resolveEvidence({
          workspaceId: fixture.workspaceId,
          tenantId: fixture.tenantId,
          shopId,
          evidence: result.evidence,
        });
      }
      failureReasons.push(...scoreRetrieval(testCase, fixture, result, resolvedEvidence));
    } catch (error) {
      failureReasons.push(`EXECUTION_ERROR:${errorMessage(error)}`);
    } finally {
      if (fixture) {
        try {
          await this.port.deleteIsolatedWorkspace(fixture.workspaceId);
        } catch (error) {
          failureReasons.push(`CLEANUP_ERROR:${errorMessage(error)}`);
        }
      }
    }

    return {
      id: testCase.id,
      status: failureReasons.length === 0 ? 'PASS' : 'FAIL',
      passed: failureReasons.length === 0,
      providerMode,
      durationMs: Date.now() - startedAt,
      failureReasons,
      actual: { retrievalStatus, evidence: resolvedEvidence, conflictItemIds },
    };
  }
}

function scoreRetrieval(
  testCase: RetrievalEvalCaseV2,
  fixture: RetrievalEvalFixture,
  result: KnowledgeRetrievalResult,
  evidence: ResolvedEvalEvidence[],
): string[] {
  const failures: string[] = [];
  const expectation = testCase.expectation;
  const forbiddenKnowledge = expectation.kind === 'CONFLICT' ? [] : expectation.forbiddenKnowledgeKeys;
  const forbiddenShop = expectation.kind === 'CONFLICT' ? [] : expectation.forbiddenShopKeys;
  const forbiddenProduct = expectation.kind === 'CONFLICT' ? [] : expectation.forbiddenProductKeys;
  evidence.forEach((entry) => {
    if (entry.workspaceId !== fixture.workspaceId) failures.push(`EVIDENCE_WORKSPACE_MISMATCH:${entry.workspaceId}`);
    if (entry.tenantId !== fixture.tenantId) failures.push(`EVIDENCE_TENANT_MISMATCH:${entry.tenantId}`);
    if (entry.shopKey !== testCase.shopKey) failures.push(`EVIDENCE_SHOP_MISMATCH:${entry.shopKey}`);
    if (forbiddenKnowledge.includes(entry.knowledgeKey)) failures.push(`FORBIDDEN_KNOWLEDGE:${entry.knowledgeKey}`);
    if (forbiddenShop.includes(entry.shopKey)) failures.push(`FORBIDDEN_SHOP:${entry.shopKey}`);
    if (entry.productKey && forbiddenProduct.includes(entry.productKey)) failures.push(`FORBIDDEN_PRODUCT:${entry.productKey}`);
  });

  if (expectation.kind === 'POSITIVE') {
    if (result.status !== 'EVIDENCE') failures.push(`RETRIEVAL_STATUS_MISMATCH:EVIDENCE:${result.status}`);
    if (!evidence.slice(0, expectation.maxRank).some((entry) => expectation.expectedKnowledgeKeys.includes(entry.knowledgeKey))) {
      failures.push(`EXPECTED_KNOWLEDGE_NOT_IN_TOP_${expectation.maxRank}`);
    }
    evidence.forEach((entry) => {
      if (entry.scope !== expectation.expectedScope) failures.push(`EVIDENCE_SCOPE_MISMATCH:${entry.scope}`);
      if (expectation.expectedScope === 'STORE' && entry.productKey !== null) failures.push(`EVIDENCE_PRODUCT_MISMATCH:${entry.productKey}`);
      if (expectation.expectedScope === 'PRODUCT' && entry.productKey !== testCase.productKey) {
        failures.push(`EVIDENCE_PRODUCT_MISMATCH:${entry.productKey ?? 'null'}`);
      }
    });
  } else if (expectation.kind === 'NO_EVIDENCE') {
    if (!expectation.allowedStatuses.includes(result.status as (typeof expectation.allowedStatuses)[number])) {
      failures.push(`RETRIEVAL_STATUS_NOT_ALLOWED:${result.status}`);
    }
    if (result.evidence.length > 0 || evidence.length > 0) failures.push('NEGATIVE_EVIDENCE_RETURNED');
  } else {
    if (result.status !== expectation.expectedStatus) failures.push(`RETRIEVAL_STATUS_MISMATCH:${expectation.expectedStatus}:${result.status}`);
    if (result.evidence.length > 0 || evidence.length > 0) failures.push('CONFLICT_EVIDENCE_RETURNED');
    if (result.conflictItemIds.length === 0) failures.push('CONFLICT_ITEM_IDS_MISSING');
  }
  return [...new Set(failures)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
