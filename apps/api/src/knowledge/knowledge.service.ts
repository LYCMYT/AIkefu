import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type KnowledgeCandidate,
  type KnowledgeConflict,
  type KnowledgeImport,
  type KnowledgeImportRow,
  type KnowledgeItem,
  type ProductLearningJobStatus,
  type KnowledgeVersion,
} from '@prisma/client';
import type { KnowledgeRetrievalResult, ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { sanitizeContext } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import { SeedCatalog } from '../seed/seed-catalog';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { AiRuntimeApplicationService } from '../ai/ai-runtime-application.service';
import { parseKnowledgeImportSource } from './knowledge.import-source';
import {
  buildProductKnowledgeSource,
  classifyImportRow,
  containsDynamicCommerceFact,
  inferKnowledgeScope,
  knowledgeFingerprint,
  normalizeKnowledgeText,
  rankKnowledgeCandidates,
  requiresDynamicFactLookup,
  tokenizeKnowledge,
  versionSwitchDecision,
  type KnowledgeScopeValue,
  type RagCandidate,
} from './knowledge.policy';
import {
  deterministicOfflineEmbeddingProvider,
  KNOWLEDGE_EMBEDDING_PROVIDER,
  pgVectorLiteral,
  type KnowledgeEmbeddingProvider,
} from './knowledge.vector';
import { WorkspaceGateway } from '../websocket/workspace.gateway';

const MAX_CSV_BYTES = 1024 * 1024;
const MAX_CSV_ROWS = 5_000;
// KnowledgeImport has no separate lease column in the frozen schema. Its
// status transition updates updatedAt, which is the durable lease heartbeat.
const IMPORT_COMMIT_LEASE_MS = 60_000;
const PRODUCT_LEARNING_LEASE_MS = 60_000;

type KnowledgeScopeInput = KnowledgeScopeValue | undefined;
type Transaction = Prisma.TransactionClient;

export type KnowledgeListInput = {
  shopId: string;
  scope?: KnowledgeScopeInput;
  productId?: string;
};

export type KnowledgeImportInput = {
  shopId: string;
  csv?: string;
  xlsx?: Buffer;
  sourceName?: string;
};

export type KnowledgeSearchInput = {
  shopId: string;
  query: string;
  scope?: KnowledgeScopeInput;
  productId?: string;
  topK?: number;
};

export type KnowledgeCreateInput = {
  shopId: string;
  scope?: KnowledgeScopeValue;
  productId?: string;
  question: string;
  answer: string;
};

export type KnowledgeRevisionInput = {
  shopId?: string;
  question?: string;
  answer?: string;
};

export type HumanKnowledgeCandidateInput = {
  shopId: string;
  conversationId: string;
  replyJobId?: string;
  question: string;
  answer: string;
  source: 'FACTUAL_CORRECTION' | 'KNOWLEDGE_ENRICHMENT';
};

export type KnowledgeConflictResolutionInput = {
  /** Optional client assertion only; ownership is derived from the conflict id. */
  shopId?: string;
  resolution: 'KEEP_LEFT' | 'KEEP_RIGHT' | 'MERGE' | 'CUSTOM';
  customQuestion?: string;
  customAnswer?: string;
};

type QuestionMatch = { itemId: string; versionId: string; answer: string };
type VectorScoreRow = { knowledgeItemId: string; versionId: string; vectorScore: number | null };
type ProductLearningOutcome = 'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
type ProductLearningSource = { productId: string; title: string; sourceText: string };
type ProductLearningTransactionResult = { outcome: ProductLearningOutcome; source?: ProductLearningSource; lease?: ProductLearningLease };
type PreparedEmbedding = { sourceText: string; vector: string };
type ProductLearningIndexPlan = {
  productId: string;
  title: string;
  sourceText: string;
  question: string;
  contentHash: string;
  knowledgeItemId: string | null;
  activeVersionId: string | null;
  sourceVersionId: string | null;
};
type ProductLearningPreparationResult = {
  outcome: ProductLearningOutcome;
  source?: ProductLearningSource;
  plan?: ProductLearningIndexPlan;
  lease?: ProductLearningLease;
};
type ImportCommitLease = { updatedAt: Date };
type ProductLearningLease = { updatedAt: Date };
type ProductFaqExtraction = {
  question: string;
  answer: string;
  scope: 'STORE' | 'PRODUCT';
  productId?: string | null;
  candidateType: 'NEW_KNOWLEDGE' | 'FACTUAL_CORRECTION' | 'KNOWLEDGE_ENRICHMENT';
  shouldCreate: boolean;
  containsTemporaryCommitment?: boolean;
  containsPII?: boolean;
};

/** A stale worker observed that another owner advanced the durable lease. */
class KnowledgeImportLeaseLostError extends Error {}
class ProductLearningLeaseLostError extends Error {}

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeedCatalog) private readonly seeds: SeedCatalog,
    @Optional() @Inject(WorkspaceGateway) private readonly gateway?: WorkspaceGateway,
    @Optional() @Inject(KNOWLEDGE_EMBEDDING_PROVIDER)
    private readonly configuredEmbeddingProvider?: KnowledgeEmbeddingProvider,
    @Optional() @Inject(AiRuntimeApplicationService) private readonly aiRuntime?: AiRuntimeApplicationService,
  ) {}

  async list(scope: WorkspaceScope, input: KnowledgeListInput) {
    this.assertScopeInput(input);
    await this.assertShop(scope, input.shopId);
    if (input.scope === 'PRODUCT') await this.assertProduct(scope, input.shopId, input.productId!);

    const now = new Date();
    const items = await this.prisma.knowledgeItem.findMany({
      where: {
        ...this.scope(scope),
        shopId: input.shopId,
        deletedAt: null,
        ...this.scopeSelector(input.scope, input.productId),
      },
      include: {
        versions: {
          where: {
            ...this.scope(scope),
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          orderBy: { version: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return items.map((item) => this.itemView(item));
  }

  async create(scope: WorkspaceScope, input: KnowledgeCreateInput) {
    let knowledgeScope: KnowledgeScopeValue;
    try {
      knowledgeScope = inferKnowledgeScope(input.productId, input.scope);
    } catch {
      throw badRequest('KNOWLEDGE_SCOPE_PRODUCT_MISMATCH', 'scope must agree with productId');
    }
    this.assertScopeInput({ ...input, scope: knowledgeScope });
    this.assertKnowledgeText(input.question, input.answer);
    const question = input.question.trim();
    const answer = input.answer.trim();
    await this.assertShop(scope, input.shopId);
    if (knowledgeScope === 'PRODUCT') await this.assertProduct(scope, input.shopId, input.productId!);
    // A configured embedding provider can be a remote call. Resolve it before
    // opening the write transaction so a slow network never owns an interactive
    // Prisma connection or publishes a partially indexed version.
    const embedding = await this.prepareEmbedding(`${question}\n${answer}`);
    const result = await this.prisma.$transaction(async (tx) => {
      const matches = await this.findQuestionMatchRecords(tx, scope, input.shopId, knowledgeScope, input.productId ?? null, input.question);
      const conflicting = matches.filter((match) => normalizeKnowledgeText(match.answer) !== normalizeKnowledgeText(input.answer));
      const explicitConflict = conflicting.length > 0;
      const item = await tx.knowledgeItem.create({
        data: {
          ...this.scope(scope),
          shopId: input.shopId,
          productId: knowledgeScope === 'PRODUCT' ? input.productId : null,
          seedKey: `manual:${this.hash(`${Date.now()}:${Math.random()}`)}`,
          scope: knowledgeScope,
          sourceType: 'MANUAL',
          businessStatus: explicitConflict ? 'CONFLICTED' : 'ENABLED',
        },
      });
      const version = await this.createReadyVersion(
        tx,
        scope,
        input.shopId,
        item.id,
        1,
        question,
        answer,
        this.hash(`${question}\n${answer}`),
        null,
        1,
        'manual',
        embedding,
      );
      if (explicitConflict) {
        await this.recordExplicitConflict(tx, scope, input.shopId, item, version, conflicting, 'MANUAL_CREATE');
      }
      if (!explicitConflict) {
        const activated = await tx.knowledgeItem.updateMany({
          where: { id: item.id, ...this.scope(scope), shopId: input.shopId, activeVersionId: null },
          data: { activeVersionId: version.id },
        });
        if (activated.count !== 1) throw this.knowledgeVersionChangedRetry();
      }
      return {
        status: explicitConflict ? ('CONFLICTED' as const) : ('CREATED' as const),
        knowledge: {
          id: item.id,
          shopId: item.shopId,
          productId: item.productId,
          scope: item.scope,
          businessStatus: explicitConflict ? 'CONFLICTED' : 'ENABLED',
          activeVersionId: explicitConflict ? null : version.id,
          version: this.versionView(version),
        },
      };
    });
    this.publishKnowledge(scope, input.shopId, result.knowledge.id, {
      businessStatus: result.knowledge.businessStatus,
      indexStatus: result.knowledge.version.indexStatus,
    });
    return result;
  }

  async revise(scope: WorkspaceScope, knowledgeId: string, input: KnowledgeRevisionInput) {
    const shopId = await this.resolveKnowledgeShop(scope, knowledgeId, input.shopId);
    await this.assertShop(scope, shopId);
    // Read the source version before the remote embedding call. The write
    // transaction below re-validates this active pointer with a CAS so a
    // concurrent revision cannot receive this vector or be switched away.
    const preflight = await this.prisma.knowledgeItem.findFirst({
      where: { id: knowledgeId, ...this.scope(scope), shopId, deletedAt: null },
      include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
    });
    if (!preflight) throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
    const preflightActive = preflight.versions.find((version) => version.id === preflight.activeVersionId) ?? preflight.versions[0];
    if (!preflightActive) throw badRequest('KNOWLEDGE_VERSION_MISSING', 'Knowledge item has no version to revise');
    const question = input.question?.trim() || preflightActive.question;
    const answer = input.answer?.trim() || preflightActive.answer;
    this.assertKnowledgeText(question, answer);
    const embedding = await this.prepareEmbedding(`${question}\n${answer}`);
    const result = await this.prisma.$transaction(async (tx) => {
      const item = await tx.knowledgeItem.findFirst({
        where: { id: knowledgeId, ...this.scope(scope), shopId, deletedAt: null },
        include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
      });
      if (!item) throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
      const active = item.versions.find((version) => version.id === item.activeVersionId) ?? item.versions[0];
      if (!active) throw badRequest('KNOWLEDGE_VERSION_MISSING', 'Knowledge item has no version to revise');
      if (item.activeVersionId !== preflight.activeVersionId || active.id !== preflightActive.id) {
        throw this.knowledgeVersionChangedRetry();
      }
      const matches = await this.findQuestionMatchRecords(tx, scope, shopId, item.scope, item.productId, question, item.id);
      const conflicting = matches.filter((candidate) => normalizeKnowledgeText(candidate.answer) !== normalizeKnowledgeText(answer));
      const explicitConflict = conflicting.length > 0;
      const next = await this.createReadyVersion(
        tx,
        scope,
        shopId,
        item.id,
        (item.versions[0]?.version ?? 0) + 1,
        question,
        answer,
        this.hash(`${question}\n${answer}`),
        active.id,
        1,
        'manual-revision',
        embedding,
      );
      if (explicitConflict) {
        const conflicted = await tx.knowledgeItem.updateMany({
          where: { id: item.id, ...this.scope(scope), shopId, activeVersionId: preflight.activeVersionId },
          data: { businessStatus: 'CONFLICTED' },
        });
        if (conflicted.count !== 1) throw this.knowledgeVersionChangedRetry();
        await this.recordExplicitConflict(tx, scope, shopId, item, next, conflicting, 'MANUAL_REVISION');
        return { status: 'CONFLICTED' as const, knowledgeId: item.id, activeVersionId: item.activeVersionId, version: this.versionView(next) };
      }
      const now = new Date();
      await tx.knowledgeVersion.updateMany({
        where: { id: active.id, ...this.scope(scope), knowledgeItemId: item.id, item: { shopId } },
        data: { effectiveTo: now },
      });
      const switched = await tx.knowledgeItem.updateMany({
        where: { id: item.id, ...this.scope(scope), shopId, activeVersionId: preflight.activeVersionId },
        data: { activeVersionId: next.id, businessStatus: 'ENABLED' },
      });
      if (switched.count !== 1) throw this.knowledgeVersionChangedRetry();
      return { status: 'UPDATED' as const, knowledgeId: item.id, activeVersionId: next.id, version: this.versionView(next) };
    });
    this.publishKnowledge(scope, shopId, knowledgeId, {
      businessStatus: result.status === 'CONFLICTED' ? 'CONFLICTED' : 'ENABLED',
      indexStatus: result.version.indexStatus,
    });
    return result;
  }

  /** Preview is idempotent for an identical CSV in the same workspace/tenant/shop. */
  async previewImport(scope: WorkspaceScope, input: KnowledgeImportInput) {
    this.assertImportInput(input);
    await this.assertShop(scope, input.shopId);
    const sourceHash = this.hash(input.csv ?? input.xlsx!);
    const existing = await this.prisma.knowledgeImport.findFirst({
      where: { ...this.scope(scope), shopId: input.shopId, csvHash: sourceHash },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    if (existing) return this.importView(existing);

    let parsed;
    try {
      parsed = await parseKnowledgeImportSource(input);
    } catch (error) {
      if (error instanceof Error && error.message === 'XLSX_FORMULAS_NOT_ALLOWED') {
        throw badRequest('XLSX_FORMULAS_NOT_ALLOWED', 'XLSX formulas are not accepted for knowledge import');
      }
      throw badRequest('XLSX_PARSE_FAILED', 'Unable to parse XLSX import');
    }
    if (parsed.rows.length > MAX_CSV_ROWS) {
      throw badRequest('CSV_ROW_LIMIT_EXCEEDED', `CSV may contain at most ${MAX_CSV_ROWS} rows`);
    }
    const externalProductIds = [...new Set(parsed.rows.flatMap((row) => (row.productExternalId ? [row.productExternalId] : [])))];
    const products = await this.prisma.product.findMany({
      where: {
        ...this.scope(scope),
        shopId: input.shopId,
        ...(externalProductIds.length > 0 ? { externalProductId: { in: externalProductIds } } : { id: { in: [] } }),
      },
      select: { id: true, externalProductId: true },
    });
    const productsByExternalId = new Map(products.map((product) => [product.externalProductId, product.id]));
    const relevantProductIds = products.map((product) => product.id);
    const existingItems = await this.prisma.knowledgeItem.findMany({
      where: {
        ...this.scope(scope),
        shopId: input.shopId,
        deletedAt: null,
        businessStatus: { not: 'DELETED' },
        OR: [
          { scope: 'STORE', productId: null },
          ...(relevantProductIds.length > 0 ? [{ scope: 'PRODUCT' as const, productId: { in: relevantProductIds } }] : []),
        ],
      },
      include: {
        versions: {
          where: { ...this.scope(scope) },
          select: { question: true, answer: true },
        },
      },
    });
    const knownAnswers = new Map<string, string[]>();
    for (const item of existingItems) {
      for (const version of item.versions) {
        const key = this.questionKey(item.scope, item.productId, version.question);
        knownAnswers.set(key, [...(knownAnswers.get(key) ?? []), version.answer]);
      }
    }

    const rows = parsed.rows.map((row) => {
      const productId = row.scope === 'PRODUCT' ? productsByExternalId.get(row.productExternalId ?? '') ?? null : null;
      const parseError = row.parseError ?? (row.scope === 'PRODUCT' && !productId ? 'PRODUCT_NOT_FOUND_IN_THIS_SHOP' : undefined);
      const key = this.questionKey(row.scope, productId, row.question);
      // Preview is the first write-policy boundary. Commit rechecks this
      // independently because preview rows are durable and may be retried.
      const policyViolation = parseError ? undefined : this.importTextViolation(row.question, row.answer);
      const decision = policyViolation
        ? { status: 'ERROR' as const, reason: policyViolation }
        : classifyImportRow({ ...row, parseError }, knownAnswers.get(key) ?? []);
      if (decision.status === 'VALID' || decision.status === 'DUPLICATE') {
        knownAnswers.set(key, [...(knownAnswers.get(key) ?? []), row.answer]);
      }
      return {
        ...this.scope(scope),
        shopId: input.shopId,
        rowNumber: row.rowNumber,
        scope: row.scope,
        productId,
        productExternalId: row.productExternalId,
        question: row.question,
        answer: row.answer,
        fingerprint: decision.fingerprint ?? null,
        status: decision.status,
        reason: decision.reason ?? null,
      };
    });

    try {
      const created = await this.prisma.knowledgeImport.create({
        data: {
          ...this.scope(scope),
          shopId: input.shopId,
          csvHash: sourceHash,
          sourceName: input.sourceName?.trim() || null,
          totalRows: rows.length,
          validRows: rows.filter((row) => row.status === 'VALID').length,
          duplicateRows: rows.filter((row) => row.status === 'DUPLICATE').length,
          conflictRows: rows.filter((row) => row.status === 'CONFLICT').length,
          errorRows: rows.filter((row) => row.status === 'ERROR').length,
          rows: { create: rows },
        },
        include: { rows: { orderBy: { rowNumber: 'asc' } } },
      });
      return this.importView(created);
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.knowledgeImport.findFirst({
        where: { ...this.scope(scope), shopId: input.shopId, csvHash: sourceHash },
        include: { rows: { orderBy: { rowNumber: 'asc' } } },
      });
      if (!raced) throw error;
      return this.importView(raced);
    }
  }

  async getImport(scope: WorkspaceScope, importId: string, expectedShopId?: string) {
    const shopId = await this.resolveImportShop(scope, importId, expectedShopId);
    await this.assertShop(scope, shopId);
    const imported = await this.prisma.knowledgeImport.findFirst({
      where: { id: importId, ...this.scope(scope), shopId },
      include: { rows: { where: { ...this.scope(scope), shopId }, orderBy: { rowNumber: 'asc' } } },
    });
    if (!imported) throw notFound('KNOWLEDGE_IMPORT_NOT_FOUND', 'Knowledge import not found in this Workspace');
    return this.importView(imported);
  }

  /**
   * A claimed PREVIEWED row is committed exactly once. Runtime conflicts are
   * converted to row outcomes so one bad row never rolls back the batch.
   */
  async commitImport(scope: WorkspaceScope, importId: string, expectedShopId?: string) {
    const shopId = await this.resolveImportShop(scope, importId, expectedShopId);
    await this.assertShop(scope, shopId);
    // Claim only the import header atomically. Individual rows deliberately
    // get their own transactions below: an invalid product or a transient
    // index failure must become one ERROR row, never roll back prior rows.
    // `updatedAt` is the frozen-schema owner token, not merely a timeout.
    const claimedAt = this.now();
    const staleBefore = new Date(claimedAt.getTime() - IMPORT_COMMIT_LEASE_MS);
    const claimedImport = await this.prisma.$transaction(async (tx) => {
      const imported = await tx.knowledgeImport.findFirst({
        where: { id: importId, ...this.scope(scope), shopId },
        include: { rows: { where: { ...this.scope(scope), shopId }, orderBy: { rowNumber: 'asc' } } },
      });
      if (!imported) throw notFound('KNOWLEDGE_IMPORT_NOT_FOUND', 'Knowledge import not found in this Workspace');
      if (imported.status === 'COMMITTED') return { imported, lease: undefined };
      if (imported.status === 'COMMITTING') {
        // A process may die after acquiring the header but before all rows
        // commit. The row state machine is idempotent, so an expired lease can
        // safely resume the remaining VALID rows. A fresh lease stays 409.
        // Compare the exact observed updatedAt rather than only an `lte`
        // window, otherwise two takeover workers could both believe they own
        // the same stale header.
        if (imported.updatedAt > staleBefore) {
          throw new ConflictException({ code: 'KNOWLEDGE_IMPORT_COMMITTING', message: 'Knowledge import is already committing' });
        }
        const leaseUpdatedAt = this.nextLeaseTimestamp(imported.updatedAt);
        const recovered = await tx.knowledgeImport.updateMany({
          where: {
            id: importId,
            ...this.scope(scope),
            shopId,
            status: 'COMMITTING',
            updatedAt: imported.updatedAt,
          },
          data: { status: 'COMMITTING', updatedAt: leaseUpdatedAt },
        });
        if (recovered.count !== 1) {
          throw new ConflictException({ code: 'KNOWLEDGE_IMPORT_COMMITTING', message: 'Knowledge import is already committing' });
        }
        return { imported, lease: { updatedAt: leaseUpdatedAt } };
      }
      if (imported.status === 'FAILED') {
        throw new ConflictException({ code: 'KNOWLEDGE_IMPORT_FAILED', message: 'Knowledge import must be previewed again' });
      }
      if (imported.status !== 'PREVIEWED') {
        throw new ConflictException({ code: 'KNOWLEDGE_IMPORT_CLAIM_LOST', message: 'Knowledge import commit was claimed elsewhere' });
      }
      const leaseUpdatedAt = this.nextLeaseTimestamp(imported.updatedAt);
      const claimed = await tx.knowledgeImport.updateMany({
        where: { id: importId, ...this.scope(scope), shopId, status: 'PREVIEWED', updatedAt: imported.updatedAt },
        data: { status: 'COMMITTING', updatedAt: leaseUpdatedAt },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: 'KNOWLEDGE_IMPORT_CLAIM_LOST', message: 'Knowledge import commit was claimed elsewhere' });
      }
      return { imported, lease: { updatedAt: leaseUpdatedAt } };
    });
    if (!claimedImport.lease) return this.importView(claimedImport.imported);

    let lease = claimedImport.lease;

    const rows = await this.prisma.knowledgeImportRow.findMany({
      where: { importId, ...this.scope(scope), shopId, status: 'VALID' },
      orderBy: { rowNumber: 'asc' },
    });
    for (const listedRow of rows) {
      try {
        // Network-backed embedding is resolved before the row's short
        // transaction. Commit rechecks the exact source text before writing it,
        // so a stale preview can never attach this vector to another row.
        const embedding = this.importTextViolation(listedRow.question, listedRow.answer)
          ? undefined
          : await this.prepareEmbedding(`${listedRow.question}\n${listedRow.answer}`);
        let renewedLease: ImportCommitLease | undefined;
        await this.prisma.$transaction(async (tx) => {
          // The header update and row write commit atomically. A worker that
          // lost ownership cannot make one more row mutation after takeover.
          renewedLease = await this.heartbeatImportLease(tx, scope, shopId, importId, lease);
          // Re-read in the row transaction.  This protects a retry after an
          // interrupted worker and makes the operation harmlessly idempotent.
          const row = await tx.knowledgeImportRow.findFirst({
            where: { id: listedRow.id, importId, ...this.scope(scope), shopId, status: 'VALID' },
          });
          if (!row) return;
          await this.commitRow(tx, scope, shopId, importId, row, embedding);
        });
        if (renewedLease) lease = renewedLease;
      } catch (error) {
        if (error instanceof KnowledgeImportLeaseLostError) throw this.importLeaseLost();
        // The failed transaction has rolled back only this row.  Persist a
        // stable, non-provider-specific error outcome in a fresh transaction.
        let renewedLease: ImportCommitLease | undefined;
        try {
          await this.prisma.$transaction(async (tx) => {
            renewedLease = await this.heartbeatImportLease(tx, scope, shopId, importId, lease);
            await tx.knowledgeImportRow.updateMany({
              where: { id: listedRow.id, importId, ...this.scope(scope), shopId, status: 'VALID' },
              data: { status: 'ERROR', reason: 'IMPORT_ROW_COMMIT_FAILED' },
            });
          });
          if (renewedLease) lease = renewedLease;
        } catch (retryError) {
          if (retryError instanceof KnowledgeImportLeaseLostError) throw this.importLeaseLost();
          throw retryError;
        }
      }
    }

    let completedImport;
    try {
      completedImport = await this.prisma.$transaction(async (tx) => {
        const completedRows = await tx.knowledgeImportRow.findMany({
          where: { importId, ...this.scope(scope), shopId },
          orderBy: { rowNumber: 'asc' },
        });
        const committedRows = completedRows.filter((row) => row.status === 'COMMITTED').length;
        const finalized = await tx.knowledgeImport.updateMany({
          // Finalization is the last owner-CAS. An old worker must never turn
          // a takeover's in-flight/finished import into its own COMMITTED run.
          where: { id: importId, ...this.scope(scope), shopId, status: 'COMMITTING', updatedAt: lease.updatedAt },
          data: {
            status: 'COMMITTED',
            committedAt: this.now(),
            // validRows is the committed valid-row total after preview rows have
            // transitioned to COMMITTED; it must not silently drop to zero.
            validRows: committedRows,
            duplicateRows: completedRows.filter((row) => row.status === 'DUPLICATE').length,
            conflictRows: completedRows.filter((row) => row.status === 'CONFLICT').length,
            errorRows: completedRows.filter((row) => row.status === 'ERROR').length,
          },
        });
        if (finalized.count !== 1) throw new KnowledgeImportLeaseLostError();
        const completed = await tx.knowledgeImport.findFirst({
          where: { id: importId, ...this.scope(scope), shopId },
          include: { rows: { where: { ...this.scope(scope), shopId }, orderBy: { rowNumber: 'asc' } } },
        });
        if (!completed) throw notFound('KNOWLEDGE_IMPORT_NOT_FOUND', 'Knowledge import not found in this Workspace');
        return this.importView(completed);
      });
    } catch (error) {
      if (error instanceof KnowledgeImportLeaseLostError) throw this.importLeaseLost();
      throw error;
    }
    this.publishKnowledge(scope, shopId, importId, {});
    return completedImport;
  }

  async reindex(scope: WorkspaceScope, knowledgeId: string, expectedShopId?: string) {
    const shopId = await this.resolveKnowledgeShop(scope, knowledgeId, expectedShopId);
    await this.assertShop(scope, shopId);
    // The embedding is deliberately resolved outside the short write
    // transaction. Keep the active id as a durable compare-and-swap token so
    // this reindex cannot resurrect or supersede a concurrently active version.
    const preflight = await this.prisma.knowledgeItem.findFirst({
      where: { id: knowledgeId, ...this.scope(scope), shopId, deletedAt: null },
      include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
    });
    if (!preflight) throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
    const preflightActive = preflight.versions.find((version) => version.id === preflight.activeVersionId) ?? preflight.versions[0];
    if (!preflightActive) throw badRequest('KNOWLEDGE_VERSION_MISSING', 'Knowledge item has no version to reindex');
    const sourceText = preflightActive.sourceText ?? `${preflightActive.question}\n${preflightActive.answer}`;
    this.assertKnowledgeText(preflightActive.question, preflightActive.answer);
    if (this.containsKnowledgePII(sourceText)) throw badRequest('KNOWLEDGE_PII_FORBIDDEN', 'PII cannot be written to knowledge');
    const embedding = await this.prepareEmbedding(sourceText);
    const version = await this.prisma.$transaction(async (tx) => {
      const item = await tx.knowledgeItem.findFirst({
        where: { id: knowledgeId, ...this.scope(scope), shopId, deletedAt: null },
        include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
      });
      if (!item) throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
      const active = item.versions.find((version) => version.id === item.activeVersionId) ?? item.versions[0];
      if (!active) throw badRequest('KNOWLEDGE_VERSION_MISSING', 'Knowledge item has no version to reindex');
      if (item.activeVersionId !== preflight.activeVersionId || active.id !== preflightActive.id) {
        throw this.knowledgeVersionChangedRetry();
      }

      const now = new Date();
      const next = await tx.knowledgeVersion.create({
        data: {
          ...this.scope(scope),
          knowledgeItemId: item.id,
          version: (item.versions[0]?.version ?? 0) + 1,
          question: active.question,
          answer: active.answer,
          sourceText,
          sourceVersion: `reindex:${active.version}`,
          confidence: active.confidence,
          indexStatus: 'INDEXING',
          contentHash: this.hash(sourceText),
          supersedesId: active.id,
          effectiveFrom: now,
        },
      });
      await this.persistScopedEmbedding(tx, scope, shopId, item.id, next.id, embedding);
      const readyUpdated = await tx.knowledgeVersion.updateMany({
        where: { id: next.id, ...this.scope(scope), knowledgeItemId: item.id, item: { shopId }, indexStatus: 'INDEXING' },
        data: { indexStatus: 'READY', indexedAt: now, searchTokensJson: tokenizeKnowledge(sourceText) },
      });
      if (readyUpdated.count !== 1) throw this.knowledgeIndexWriteConflict();
      const ready = await tx.knowledgeVersion.findFirst({
        where: { id: next.id, ...this.scope(scope), knowledgeItemId: item.id, item: { shopId } },
      });
      if (!ready) throw badRequest('KNOWLEDGE_REINDEX_FAILED', 'Knowledge version was not indexed');
      const switching = versionSwitchDecision({
        currentActiveVersionId: item.activeVersionId,
        nextVersionId: ready.id,
        nextIndexStatus: ready.indexStatus,
      });
      if (switching.switched) {
        if (item.activeVersionId) {
          await tx.knowledgeVersion.updateMany({
            where: { id: item.activeVersionId, ...this.scope(scope), knowledgeItemId: item.id, item: { shopId } },
            data: { effectiveTo: now },
          });
        }
        const switched = await tx.knowledgeItem.updateMany({
          where: { id: item.id, ...this.scope(scope), shopId, activeVersionId: preflight.activeVersionId },
          data: { activeVersionId: switching.activeVersionId },
        });
        if (switched.count !== 1) throw this.knowledgeVersionChangedRetry();
      }
      return this.versionView(ready);
    });
    this.publishKnowledge(scope, shopId, knowledgeId, { indexStatus: version.indexStatus });
    return version;
  }

  async delete(scope: WorkspaceScope, knowledgeId: string, expectedShopId?: string) {
    const shopId = await this.resolveKnowledgeShop(scope, knowledgeId, expectedShopId);
    await this.assertShop(scope, shopId);
    const result = await this.prisma.knowledgeItem.updateMany({
      where: { id: knowledgeId, ...this.scope(scope), shopId, deletedAt: null },
      data: { businessStatus: 'DELETED', deletedAt: new Date(), activeVersionId: null },
    });
    if (result.count !== 1) throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
    this.publishKnowledge(scope, shopId, knowledgeId, { businessStatus: 'DELETED' });
    return { id: knowledgeId, status: 'DELETED' as const };
  }

  async listCandidates(scope: WorkspaceScope, shopId: string, status?: string) {
    const scopedShopId = shopId?.trim() || undefined;
    if (scopedShopId) await this.assertShop(scope, scopedShopId);
    const candidates = await this.prisma.knowledgeCandidate.findMany({
      where: {
        ...this.scope(scope),
        ...(scopedShopId ? { shopId: scopedShopId } : {}),
        ...(status ? { status: status as Prisma.EnumKnowledgeCandidateStatusFilter['equals'] } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    return candidates.map((candidate) => this.candidateView(candidate));
  }

  /**
   * Human edits are reviewable suggestions, never an implicit publication
   * path. The same dynamic-fact and PII policy as every other knowledge write
   * runs before the durable candidate row is inserted.
   */
  async createHumanCandidate(scope: WorkspaceScope, input: HumanKnowledgeCandidateInput) {
    this.assertKnowledgeText(input.question, input.answer);
    await this.assertShop(scope, input.shopId);
    return this.prisma.$transaction((tx) => this.createHumanCandidateInTransaction(tx, scope, input));
  }

  /**
   * Used by the human-final transaction so an accepted factual correction can
   * never be sent without its review candidate.  The caller owns the scoped
   * Conversation lock, which also serializes idempotent retry lookup/create.
   */
  async createHumanCandidateInTransaction(
    tx: Prisma.TransactionClient,
    scope: WorkspaceScope,
    input: HumanKnowledgeCandidateInput,
  ) {
    this.assertKnowledgeText(input.question, input.answer);
    const question = input.question.trim();
    const answer = input.answer.trim();
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, ...this.scope(scope), shopId: input.shopId },
      select: { id: true },
    });
    if (!conversation) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation not found in this Workspace/shop');
    if (input.replyJobId) {
      const replyJob = await tx.replyJob.findFirst({
        where: { id: input.replyJobId, conversationId: input.conversationId, ...this.scope(scope), shopId: input.shopId },
        select: { id: true },
      });
      if (!replyJob) throw notFound('REPLY_JOB_NOT_FOUND', 'Reply job not found in this Workspace/shop');
    }
    const existing = await tx.knowledgeCandidate.findFirst({
      where: {
        ...this.scope(scope), shopId: input.shopId, sourceConversationId: input.conversationId,
        sourceReplyJobId: input.replyJobId ?? null, source: `HUMAN_${input.source}`,
        proposedQuestion: question, proposedAnswer: answer, status: 'PENDING',
      },
      select: { id: true, status: true },
    });
    if (existing) return existing;
    return tx.knowledgeCandidate.create({
      data: {
        ...this.scope(scope), shopId: input.shopId, source: `HUMAN_${input.source}`,
        proposedQuestion: question, proposedAnswer: answer, status: 'PENDING',
        sourceConversationId: input.conversationId, sourceReplyJobId: input.replyJobId,
      },
    });
  }

  async listConflicts(scope: WorkspaceScope, shopId: string, status?: string) {
    const scopedShopId = shopId?.trim() || undefined;
    if (scopedShopId) await this.assertShop(scope, scopedShopId);
    const conflicts = await this.prisma.knowledgeConflict.findMany({
      where: {
        ...this.scope(scope),
        ...(scopedShopId ? { shopId: scopedShopId } : {}),
        ...(status ? { status: status as Prisma.EnumKnowledgeConflictStatusFilter['equals'] } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    return this.conflictViews(scope, conflicts, scopedShopId);
  }

  async getConflict(scope: WorkspaceScope, conflictId: string, expectedShopId?: string) {
    const ownership = await this.prisma.knowledgeConflict.findFirst({
      where: { id: conflictId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!ownership || (expectedShopId?.trim() && ownership.shopId !== expectedShopId)) {
      throw notFound('KNOWLEDGE_CONFLICT_NOT_FOUND', 'Knowledge conflict not found in this Workspace');
    }
    await this.assertShop(scope, ownership.shopId);
    const conflict = await this.prisma.knowledgeConflict.findFirst({
      where: { id: conflictId, ...this.scope(scope), shopId: ownership.shopId },
    });
    if (!conflict) throw notFound('KNOWLEDGE_CONFLICT_NOT_FOUND', 'Knowledge conflict not found in this Workspace');
    const [view] = await this.conflictViews(scope, [conflict], ownership.shopId);
    if (!view) throw notFound('KNOWLEDGE_CONFLICT_NOT_FOUND', 'Knowledge conflict not found in this Workspace');
    return view;
  }

  /** A candidate becomes knowledge only after this explicit human approval. */
  async approveCandidate(scope: WorkspaceScope, candidateId: string, expectedShopId?: string) {
    const ownership = await this.prisma.knowledgeCandidate.findFirst({
      where: { id: candidateId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!ownership || (expectedShopId?.trim() && expectedShopId !== ownership.shopId)) {
      throw notFound('KNOWLEDGE_CANDIDATE_NOT_FOUND', 'Knowledge candidate not found in this Workspace');
    }
    await this.assertShop(scope, ownership.shopId);
    const snapshot = await this.prisma.knowledgeCandidate.findFirst({
      where: { id: candidateId, ...this.scope(scope), shopId: ownership.shopId },
    });
    if (!snapshot) throw notFound('KNOWLEDGE_CANDIDATE_NOT_FOUND', 'Knowledge candidate not found in this Workspace');
    if (snapshot.status === 'PUBLISHED') return { status: 'ACCEPTED' as const, operationId: snapshot.id, knowledgeId: null };
    if (snapshot.status === 'REJECTED' || snapshot.status === 'DUPLICATE') {
      throw new ConflictException({ code: 'KNOWLEDGE_CANDIDATE_NOT_APPROVABLE', message: 'Candidate cannot be approved from its current status' });
    }
    if (snapshot.status === 'CONFLICTED') {
      throw new ConflictException({ code: 'KNOWLEDGE_CANDIDATE_CONFLICTED', message: 'Conflicted candidates require conflict resolution before approval' });
    }
    // Candidate text can be operator- or model-authored. Resolve the remote
    // vector before the transaction, then require the candidate snapshot to
    // remain identical when publishing it.
    this.assertKnowledgeText(snapshot.proposedQuestion, snapshot.proposedAnswer);
    const embedding = await this.prepareEmbedding(`${snapshot.proposedQuestion}\n${snapshot.proposedAnswer}`);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.knowledgeCandidate.findFirst({
        where: { id: candidateId, ...this.scope(scope), shopId: ownership.shopId },
      });
      if (!candidate) throw notFound('KNOWLEDGE_CANDIDATE_NOT_FOUND', 'Knowledge candidate not found in this Workspace');
      if (candidate.status === 'PUBLISHED') return { status: 'ACCEPTED' as const, operationId: candidate.id, knowledgeId: null };
      if (candidate.status === 'REJECTED' || candidate.status === 'DUPLICATE') {
        throw new ConflictException({ code: 'KNOWLEDGE_CANDIDATE_NOT_APPROVABLE', message: 'Candidate cannot be approved from its current status' });
      }
      if (candidate.status === 'CONFLICTED') {
        throw new ConflictException({ code: 'KNOWLEDGE_CANDIDATE_CONFLICTED', message: 'Conflicted candidates require conflict resolution before approval' });
      }
      this.assertKnowledgeText(candidate.proposedQuestion, candidate.proposedAnswer);
      if (
        candidate.status !== snapshot.status ||
        candidate.productId !== snapshot.productId ||
        candidate.proposedQuestion !== snapshot.proposedQuestion ||
        candidate.proposedAnswer !== snapshot.proposedAnswer ||
        candidate.updatedAt.getTime() !== snapshot.updatedAt.getTime()
      ) {
        throw this.knowledgeVersionChangedRetry();
      }
      const knowledgeScope = inferKnowledgeScope(candidate.productId ?? undefined);
      if (knowledgeScope === 'PRODUCT') {
        const product = await tx.product.findFirst({
          where: { id: candidate.productId!, ...this.scope(scope), shopId: ownership.shopId },
          select: { id: true },
        });
        if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Candidate product not found in this Workspace/shop');
      }
      const matches = await this.findQuestionMatchRecords(
        tx,
        scope,
        ownership.shopId,
        knowledgeScope,
        candidate.productId,
        candidate.proposedQuestion,
      );
      const duplicate = matches.find((match) => normalizeKnowledgeText(match.answer) === normalizeKnowledgeText(candidate.proposedAnswer));
      const conflict = matches.find((match) => normalizeKnowledgeText(match.answer) !== normalizeKnowledgeText(candidate.proposedAnswer));
      if (duplicate || conflict) {
        const classified = await tx.knowledgeCandidate.updateMany({
          where: { id: candidate.id, ...this.scope(scope), shopId: ownership.shopId, status: snapshot.status, updatedAt: snapshot.updatedAt },
          data: {
            status: duplicate ? 'DUPLICATE' : 'CONFLICTED',
            ...(duplicate ? { duplicateOfId: duplicate.itemId } : { conflictWithId: conflict!.itemId }),
          },
        });
        if (classified.count !== 1) throw this.knowledgeVersionChangedRetry();
        return { status: 'ACCEPTED' as const, operationId: candidate.id, knowledgeId: null };
      }

      const item = await tx.knowledgeItem.create({
        data: {
          ...this.scope(scope),
          shopId: ownership.shopId,
          productId: candidate.productId,
          seedKey: `candidate:${candidate.id}`,
          scope: knowledgeScope,
          sourceType: 'HUMAN_REVIEWED',
          businessStatus: 'ENABLED',
        },
      });
      const version = await this.createReadyVersion(
        tx,
        scope,
        ownership.shopId,
        item.id,
        1,
        candidate.proposedQuestion,
        candidate.proposedAnswer,
        this.hash(`${candidate.proposedQuestion}\n${candidate.proposedAnswer}`),
        null,
        1,
        `candidate:${candidate.id}`,
        embedding,
      );
      const activated = await tx.knowledgeItem.updateMany({
        where: { id: item.id, ...this.scope(scope), shopId: ownership.shopId, activeVersionId: null },
        data: { activeVersionId: version.id },
      });
      if (activated.count !== 1) throw this.knowledgeVersionChangedRetry();
      const published = await tx.knowledgeCandidate.updateMany({
        where: { id: candidate.id, ...this.scope(scope), shopId: ownership.shopId, status: snapshot.status, updatedAt: snapshot.updatedAt },
        data: { status: 'PUBLISHED' },
      });
      if (published.count !== 1) throw this.knowledgeVersionChangedRetry();
      return { status: 'ACCEPTED' as const, operationId: candidate.id, knowledgeId: item.id };
    });
    this.publishKnowledge(scope, ownership.shopId, outcome.knowledgeId ?? candidateId, {
      businessStatus: outcome.knowledgeId ? 'ENABLED' : undefined,
    });
    return outcome;
  }

  async rejectCandidate(scope: WorkspaceScope, candidateId: string, expectedShopId?: string): Promise<void> {
    const ownership = await this.prisma.knowledgeCandidate.findFirst({
      where: { id: candidateId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!ownership || (expectedShopId?.trim() && expectedShopId !== ownership.shopId)) {
      throw notFound('KNOWLEDGE_CANDIDATE_NOT_FOUND', 'Knowledge candidate not found in this Workspace');
    }
    await this.assertShop(scope, ownership.shopId);
    const result = await this.prisma.knowledgeCandidate.updateMany({
      where: { id: candidateId, ...this.scope(scope), shopId: ownership.shopId, status: { not: 'PUBLISHED' } },
      data: { status: 'REJECTED' },
    });
    if (result.count !== 1) {
      throw new ConflictException({ code: 'KNOWLEDGE_CANDIDATE_PUBLISHED', message: 'Published candidates cannot be rejected' });
    }
    this.publishKnowledge(scope, ownership.shopId, candidateId, {});
  }

  /**
   * Conflict resolution is intentionally an explicit human action. OPEN rows
   * never choose a side in RAG. KEEP_LEFT/KEEP_RIGHT name the persisted side
   * explicitly; MERGE/CUSTOM require reviewer-authored text and create a
   * pending candidate rather than publishing a synthesized answer.
   */
  async resolveConflict(scope: WorkspaceScope, conflictId: string, input: KnowledgeConflictResolutionInput) {
    const ownership = await this.prisma.knowledgeConflict.findFirst({
      where: { id: conflictId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!ownership) throw notFound('KNOWLEDGE_CONFLICT_NOT_FOUND', 'Knowledge conflict not found in this Workspace');
    if (input.shopId && input.shopId !== ownership.shopId) {
      throw badRequest('SHOP_ID_MISMATCH', 'shopId does not match the conflict owner');
    }
    await this.assertShop(scope, ownership.shopId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      const conflict = await tx.knowledgeConflict.findFirst({
        where: { id: conflictId, ...this.scope(scope), shopId: ownership.shopId, status: 'OPEN' },
      });
      if (!conflict) {
        throw new ConflictException({ code: 'KNOWLEDGE_CONFLICT_NOT_OPEN', message: 'Knowledge conflict is already resolved or unavailable' });
      }
      const sides = await tx.knowledgeItem.findMany({
        where: {
          ...this.scope(scope),
          shopId: ownership.shopId,
          id: { in: [conflict.leftItemId, conflict.rightItemId] },
          deletedAt: null,
        },
        select: { id: true, scope: true, productId: true, activeVersionId: true },
      });
      const left = sides.find((item) => item.id === conflict.leftItemId);
      const right = sides.find((item) => item.id === conflict.rightItemId);
      if (!left || !right) {
        throw badRequest('KNOWLEDGE_CONFLICT_SIDE_INVALID', 'Conflict sides are not available in this scope');
      }
      const sideVersions = await tx.knowledgeVersion.findMany({
        where: {
          ...this.scope(scope),
          id: { in: [conflict.leftVersionId, conflict.rightVersionId] },
          item: { shopId: ownership.shopId },
        },
        select: {
          id: true,
          knowledgeItemId: true,
          indexStatus: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
      const leftVersion = sideVersions.find((version) => version.id === conflict.leftVersionId && version.knowledgeItemId === left.id);
      const rightVersion = sideVersions.find((version) => version.id === conflict.rightVersionId && version.knowledgeItemId === right.id);
      if (!leftVersion || !rightVersion) {
        throw badRequest('KNOWLEDGE_CONFLICT_VERSION_INVALID', 'Conflict versions are not available in this scope');
      }

      if (input.resolution === 'KEEP_LEFT' || input.resolution === 'KEEP_RIGHT') {
        const keepLeft = input.resolution === 'KEEP_LEFT';
        const winner = keepLeft ? left : right;
        const loser = keepLeft ? right : left;
        const winnerVersion = keepLeft ? leftVersion : rightVersion;
        if (winnerVersion.indexStatus !== 'READY') {
          throw badRequest('KNOWLEDGE_CONFLICT_WINNER_NOT_READY', 'A resolved conflict requires the selected side to be READY');
        }
        const now = new Date();
        const winnerIsEffective = winnerVersion.effectiveFrom.getTime() <= now.getTime()
          && (winnerVersion.effectiveTo === null || winnerVersion.effectiveTo.getTime() > now.getTime());
        const winnerIsCurrent = winner.activeVersionId === null || winner.activeVersionId === winnerVersion.id;
        if (!winnerIsEffective || !winnerIsCurrent) {
          throw badRequest(
            'KNOWLEDGE_CONFLICT_WINNER_STALE',
            'The selected conflict version is historical; choose a current side or create a reviewed replacement',
          );
        }
        await tx.knowledgeVersion.updateMany({
          where: {
            ...this.scope(scope),
            knowledgeItemId: winner.id,
            id: { not: winnerVersion.id },
            effectiveTo: null,
            item: { shopId: ownership.shopId },
          },
          data: { effectiveTo: now },
        });
        await tx.knowledgeItem.updateMany({
          where: { id: winner.id, ...this.scope(scope), shopId: ownership.shopId, deletedAt: null },
          data: { businessStatus: 'ENABLED', activeVersionId: winnerVersion.id },
        });
        await tx.knowledgeItem.updateMany({
          where: { id: loser.id, ...this.scope(scope), shopId: ownership.shopId, deletedAt: null },
          data: { businessStatus: 'OUTDATED', activeVersionId: null },
        });
        await this.markConflictResolved(tx, scope, ownership.shopId, conflict.id, {
          resolution: input.resolution,
          winnerItemId: winner.id,
          winnerVersionId: winnerVersion.id,
        });
        return { status: 'ACCEPTED' as const, operationId: conflict.id };
      }

      const customQuestion = input.customQuestion?.trim() ?? '';
      const customAnswer = input.customAnswer?.trim() ?? '';
      if (!customQuestion || !customAnswer) {
        throw badRequest('KNOWLEDGE_CONFLICT_CUSTOM_REQUIRED', 'MERGE and CUSTOM require customQuestion and customAnswer');
      }
      this.assertKnowledgeText(customQuestion, customAnswer);
      if (left.scope !== right.scope || left.productId !== right.productId) {
        throw badRequest('KNOWLEDGE_CONFLICT_SCOPE_MISMATCH', 'MERGE/CUSTOM can only create a candidate from matching scopes');
      }
      const candidate = await tx.knowledgeCandidate.create({
        data: {
          ...this.scope(scope),
          shopId: ownership.shopId,
          productId: left.productId,
          source: `CONFLICT_${input.resolution}`,
          proposedQuestion: customQuestion,
          proposedAnswer: customAnswer,
          status: 'PENDING',
          conflictWithId: left.id,
        },
      });
      // No synthesized answer is selected. Both historical sides remain out of
      // RAG until a reviewer separately approves the pending candidate.
      await tx.knowledgeItem.updateMany({
        where: { id: { in: [left.id, right.id] }, ...this.scope(scope), shopId: ownership.shopId, deletedAt: null },
        data: { businessStatus: 'CONFLICTED', activeVersionId: null },
      });
      await this.markConflictResolved(tx, scope, ownership.shopId, conflict.id, {
        resolution: input.resolution,
        candidateId: candidate.id,
      });
      return { status: 'ACCEPTED' as const, operationId: conflict.id, candidateId: candidate.id };
    });
    this.publishKnowledge(scope, ownership.shopId, conflictId, {});
    return outcome;
  }

  async search(scope: WorkspaceScope, input: KnowledgeSearchInput): Promise<KnowledgeRetrievalResult> {
    this.assertScopeInput(input);
    if (!input.query?.trim()) throw badRequest('KNOWLEDGE_QUERY_REQUIRED', 'query is required');
    await this.assertShop(scope, input.shopId);
    if (input.scope === 'PRODUCT') await this.assertProduct(scope, input.shopId, input.productId!);
    if (input.productId && input.scope !== 'STORE') await this.assertProduct(scope, input.shopId, input.productId);
    if (requiresDynamicFactLookup(input.query)) {
      return { status: 'DYNAMIC_FACT_REQUIRED', evidence: [], conflictItemIds: [] };
    }

    const now = new Date();
    const selector = this.scopeSelector(input.scope, input.productId);
    const items = await this.prisma.knowledgeItem.findMany({
      where: { ...this.scope(scope), shopId: input.shopId, deletedAt: null, ...selector },
      include: {
        versions: {
          where: {
            ...this.scope(scope),
            indexStatus: 'READY',
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          orderBy: { version: 'desc' },
        },
      },
    });
    // pgvector query repeats the same metadata predicate as the Prisma query;
    // the map is then fused with keyword scoring rather than trusted alone.
    const vectorScores = await this.findScopedVectorScores(scope, input, now);
    const openConflicts = await this.prisma.knowledgeConflict.findMany({
      where: { ...this.scope(scope), shopId: input.shopId, status: 'OPEN' },
      select: { leftItemId: true, rightItemId: true, leftVersionId: true, rightVersionId: true },
    });
    const conflictVersionIds = new Set(openConflicts.flatMap((conflict) => [conflict.leftVersionId, conflict.rightVersionId]));
    const candidates = this.toRagCandidates(items, 'normal', vectorScores);
    const conflicts = this.toRagCandidates(items, 'conflict', vectorScores, conflictVersionIds);
    const ranked = rankKnowledgeCandidates(candidates, { ...scope, shopId: input.shopId, productId: input.productId, query: input.query, now, topK: input.topK });
    // Reuse the same strict metadata/lexical match for conflicts, while keeping
    // their actual status out of normal ranking. Conflict is a hard stop.
    const rankedConflicts = rankKnowledgeCandidates(
      conflicts.map((candidate) => ({ ...candidate, businessStatus: 'ENABLED' })),
      { ...scope, shopId: input.shopId, productId: input.productId, query: input.query, now, topK: input.topK },
    );
    if (rankedConflicts.length > 0) {
      return {
        status: 'CONFLICTED',
        evidence: [],
        conflictItemIds: [...new Set(rankedConflicts.map((candidate) => candidate.itemId))].sort(),
      };
    }
    if (ranked.length === 0) return { status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] };

    // Copy and freeze each value now. Callers can persist this evidence object
    // with a reply without later edits to KnowledgeItem/KnowledgeVersion
    // mutating the historical content snapshot.
    const evidence: ReplyEvidenceSnapshot[] = ranked.map((candidate) =>
      Object.freeze({
        itemId: candidate.itemId,
        versionId: candidate.versionId,
        version: candidate.version,
        source: candidate.sourceType,
        scope: candidate.scope,
        productId: candidate.productId,
        contentSnapshot: Object.freeze({ question: candidate.question, answer: candidate.answer }),
        retrievalScore: Number(candidate.score.toFixed(6)),
      }),
    );
    return { status: 'EVIDENCE', evidence, conflictItemIds: [] };
  }

  /** Synthetic only: it synchronizes the fixed seed, never a live platform. */
  async syncProducts(scope: WorkspaceScope, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, ...this.scope(scope) },
      select: { id: true, seedKey: true },
    });
    if (!shop) throw notFound('SHOP_NOT_FOUND', 'Shop not found in this Workspace');
    const seed = await this.seeds.load();
    const products = seed.products.filter((product) => product.shopKey === shop.seedKey);
    const syncedProductIds = await this.prisma.$transaction(async (tx) => {
      const productIds: string[] = [];
      for (const source of products) {
        const product = await tx.product.upsert({
          where: {
            workspaceId_tenantId_shopId_externalProductId: {
              workspaceId: scope.workspaceId,
              tenantId: scope.tenantId,
              shopId,
              externalProductId: source.externalProductId,
            },
          },
          create: {
            ...this.scope(scope),
            shopId,
            seedKey: source.key,
            externalProductId: source.externalProductId,
            title: source.title,
            description: source.description,
            contentHash: this.hash(source.description),
            status: source.status,
            recommendable: source.recommendable,
          },
          update: {
            title: source.title,
            description: source.description,
            contentHash: this.hash(source.description),
            status: source.status,
            recommendable: source.recommendable,
          },
        });
        productIds.push(product.id);
        for (const sku of source.skus) {
          await tx.productSku.upsert({
            where: {
              workspaceId_tenantId_productId_externalSkuId: {
                workspaceId: scope.workspaceId,
                tenantId: scope.tenantId,
                productId: product.id,
                externalSkuId: sku.externalSkuId,
              },
            },
            create: {
              ...this.scope(scope),
              shopId,
              productId: product.id,
              externalSkuId: sku.externalSkuId,
              attributesJson: sku.attributes,
              price: new Prisma.Decimal(sku.price),
              inventory: sku.inventory,
            },
            update: { attributesJson: sku.attributes, price: new Prisma.Decimal(sku.price), inventory: sku.inventory },
          });
        }
      }
      return productIds;
    });
    syncedProductIds.forEach((productId) => this.publishProduct(scope, shopId, productId));
    return { status: 'SUCCEEDED' as const, synthetic: true, productsSynced: syncedProductIds.length };
  }

  async listProductLearningJobs(scope: WorkspaceScope, shopId: string) {
    await this.assertShop(scope, shopId);
    const jobs = await this.prisma.productLearningJob.findMany({
      where: { ...this.scope(scope), shopId },
      include: { items: { where: { ...this.scope(scope), shopId }, orderBy: { productId: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return jobs.map((job) => this.productLearningJobView(job));
  }

  async startProductLearning(scope: WorkspaceScope, shopId: string, productIds?: string[], retryFailed = false) {
    await this.assertShop(scope, shopId);
    const requestedProductIds = [...new Set((productIds ?? []).filter((id) => id?.trim()))];
    for (const productId of requestedProductIds) await this.assertProduct(scope, shopId, productId);
    const products = await this.prisma.product.findMany({
      where: {
        ...this.scope(scope),
        shopId,
        status: { not: 'DELETED' },
        ...(requestedProductIds.length > 0 ? { id: { in: requestedProductIds } } : {}),
      },
      select: { id: true, contentHash: true, title: true, description: true },
      orderBy: { id: 'asc' },
    });
    const sourceFingerprint = this.hash(products.map((product) => `${product.id}:${product.contentHash ?? this.hash(product.description)}`).join('|'));
    const existing = await this.prisma.productLearningJob.findFirst({
      where: { ...this.scope(scope), shopId, sourceFingerprint },
      include: { items: { where: { ...this.scope(scope), shopId }, orderBy: { productId: 'asc' } } },
    });
    if (existing) {
      // Creation and execution are separate durable steps. A process can die
      // after creating the PENDING job, so every later identical start must
      // attempt the same scoped PENDING -> RUNNING CAS rather than returning
      // a job that no worker will ever pick up. retryFailed only controls
      // resetting terminal failed items; it must not suppress this resume.
      if (existing.status === 'PENDING') {
        return this.runProductLearningJob(scope, existing.id, shopId);
      }
      const staleBefore = new Date(this.now().getTime() - PRODUCT_LEARNING_LEASE_MS);
      if (existing.status === 'RUNNING' && this.isProductLearningLeaseStale(existing, staleBefore)) {
        const reclaimed = await this.reclaimProductLearningJob(scope, shopId, existing, staleBefore, false);
        if (reclaimed) return this.runProductLearningJob(scope, existing.id, shopId);
        return this.currentProductLearningJobView(scope, existing.id, shopId);
      }
      if (retryFailed && (existing.status === 'FAILED' || existing.status === 'PARTIAL_SUCCESS')) {
        const reclaimed = await this.reclaimProductLearningJob(scope, shopId, existing, staleBefore, true);
        if (reclaimed) return this.runProductLearningJob(scope, existing.id, shopId);
        return this.currentProductLearningJobView(scope, existing.id, shopId);
      }
      return this.productLearningJobView(existing);
    }

    let job;
    try {
      job = await this.prisma.productLearningJob.create({
        data: {
          ...this.scope(scope),
          shopId,
          sourceFingerprint,
          totalProducts: products.length,
          items: { create: products.map((product) => ({ ...this.scope(scope), shopId, productId: product.id })) },
        },
        include: { items: { where: { ...this.scope(scope), shopId }, orderBy: { productId: 'asc' } } },
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.productLearningJob.findFirst({
        where: { ...this.scope(scope), shopId, sourceFingerprint },
        include: { items: { orderBy: { productId: 'asc' } } },
      });
      if (!raced) throw error;
      if (raced.status === 'PENDING') return this.runProductLearningJob(scope, raced.id, shopId);
      return this.productLearningJobView(raced);
    }
    return this.runProductLearningJob(scope, job.id, shopId);
  }

  async startProductLearningForProduct(scope: WorkspaceScope, productId: string, expectedShopId?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!product || (expectedShopId?.trim() && product.shopId !== expectedShopId)) {
      throw notFound('PRODUCT_NOT_FOUND', 'Product not found in this Workspace');
    }
    return this.startProductLearning(scope, product.shopId, [productId]);
  }

  private async runProductLearningJob(scope: WorkspaceScope, jobId: string, shopId: string) {
    const job = await this.prisma.productLearningJob.findFirst({
      where: { id: jobId, ...this.scope(scope), shopId },
      include: { items: { where: { ...this.scope(scope), shopId }, orderBy: { productId: 'asc' } } },
    });
    if (!job) throw notFound('PRODUCT_LEARNING_JOB_NOT_FOUND', 'Product learning job not found in this Workspace');
    if (job.status !== 'PENDING') return this.productLearningJobView(job);
    const claimUpdatedAt = this.nextLeaseTimestamp(job.updatedAt);
    const claimed = await this.prisma.productLearningJob.updateMany({
      where: { id: jobId, ...this.scope(scope), shopId, status: 'PENDING', updatedAt: job.updatedAt },
      data: { status: 'RUNNING', startedAt: this.now(), completedAt: null, updatedAt: claimUpdatedAt },
    });
    if (claimed.count !== 1) {
      return this.currentProductLearningJobView(scope, jobId, shopId);
    }
    const lease: ProductLearningLease = { updatedAt: claimUpdatedAt };

    let succeeded = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of job.items.filter((item) => item.status === 'PENDING')) {
      let outcome: ProductLearningOutcome;
      try {
        outcome = await this.learnOneProduct(scope, shopId, job.id, item.productId, lease);
      } catch (error) {
        if (error instanceof ProductLearningLeaseLostError) {
          return this.currentProductLearningJobView(scope, jobId, shopId);
        }
        throw error;
      }
      if (outcome === 'CREATED') {
        succeeded += 1;
        created += 1;
      } else if (outcome === 'UPDATED') {
        succeeded += 1;
        updated += 1;
      } else if (outcome === 'SKIPPED') {
        succeeded += 1;
        skipped += 1;
      } else {
        failed += 1;
      }
    }
    const allItems = await this.prisma.productLearningJobItem.findMany({
      where: { jobId, ...this.scope(scope), shopId },
      select: { status: true, reason: true },
    });
    created = allItems.filter((item) => item.reason === 'CREATED').length;
    updated = allItems.filter((item) => item.reason === 'UPDATED').length;
    skipped = allItems.filter((item) => item.status === 'SUCCEEDED' && item.reason !== 'CREATED' && item.reason !== 'UPDATED').length;
    failed = allItems.filter((item) => item.status === 'FAILED').length;
    succeeded = allItems.filter((item) => item.status === 'SUCCEEDED').length;
    const status = failed === 0 ? 'SUCCEEDED' : succeeded > 0 ? 'PARTIAL_SUCCESS' : 'FAILED';
    const finalized = await this.prisma.productLearningJob.updateMany({
      // A reclaimed worker may finish its stale source work, but it can never
      // overwrite the current owner's job totals/status.
      where: { id: jobId, ...this.scope(scope), shopId, status: 'RUNNING', updatedAt: lease.updatedAt },
      data: {
        status,
        createdProducts: created,
        updatedProducts: updated,
        skippedProducts: skipped,
        failedProducts: failed,
        completedAt: this.now(),
      },
    });
    if (finalized.count !== 1) return this.currentProductLearningJobView(scope, jobId, shopId);
    const view = await this.currentProductLearningJobView(scope, jobId, shopId);
    view.items.forEach((item) => this.publishProduct(scope, shopId, item.productId, item.status));
    return view;
  }

  private async learnOneProduct(
    scope: WorkspaceScope,
    shopId: string,
    jobId: string,
    productId: string,
    lease?: ProductLearningLease,
  ): Promise<ProductLearningOutcome> {
    try {
      // Claim and read in a short transaction, then resolve the (potentially
      // remote) vector after that transaction closes. The final transaction
      // compares this plan again before it makes a version READY/active.
      const preparation = await this.prisma.$transaction(async (tx): Promise<ProductLearningPreparationResult> => {
        const renewedLease = lease
          ? await this.heartbeatProductLearningLease(tx, scope, shopId, jobId, lease)
          : undefined;
        const itemClaimed = await tx.productLearningJobItem.updateMany({
          where: { jobId, productId, ...this.scope(scope), shopId, status: 'PENDING' },
          data: { status: 'PROCESSING' },
        });
        if (itemClaimed.count !== 1) {
          return { outcome: 'SKIPPED', ...(renewedLease ? { lease: renewedLease } : {}) };
        }
        const product = await tx.product.findFirst({
          where: { id: productId, ...this.scope(scope), shopId, status: { not: 'DELETED' } },
          select: { id: true, title: true, description: true },
        });
        if (!product) {
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'FAILED', 'PRODUCT_NOT_FOUND'),
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        const sourceText = buildProductKnowledgeSource(product);
        if (!sourceText) {
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'FAILED', 'NO_STABLE_PRODUCT_KNOWLEDGE'),
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        const question = `商品「${product.title}」的稳定材质、功能和使用说明是什么？`;
        // Synthetic catalog text is still untrusted input. It cannot create
        // an enabled source version or become model context when it contains
        // PII, even though no external platform is contacted in this demo.
        if (this.containsKnowledgePII(question, sourceText)) {
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'FAILED', 'KNOWLEDGE_PII_FORBIDDEN'),
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        const contentHash = this.hash(sourceText);
        const existing = await tx.knowledgeItem.findFirst({
          where: {
            ...this.scope(scope),
            shopId,
            productId,
            scope: 'PRODUCT',
            sourceType: 'AUTO_LEARNED',
            deletedAt: null,
          },
          include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
          orderBy: { updatedAt: 'desc' },
        });
        const active = existing?.versions.find((version) => version.id === existing.activeVersionId) ?? existing?.versions[0];
        if (active?.contentHash === contentHash) {
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'SUCCEEDED', 'CONTENT_UNCHANGED'),
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        return {
          outcome: 'SKIPPED',
          plan: {
            productId: product.id,
            title: product.title,
            sourceText,
            question,
            contentHash,
            knowledgeItemId: existing?.id ?? null,
            activeVersionId: existing?.activeVersionId ?? null,
            sourceVersionId: active?.id ?? null,
          },
          ...(renewedLease ? { lease: renewedLease } : {}),
        };
      });
      if (lease && preparation.lease) lease.updatedAt = preparation.lease.updatedAt;
      if (!preparation.plan) return preparation.outcome;

      // This is the only provider call in the product-learning write path. It
      // intentionally sits between two short transactions.
      const embedding = await this.prepareEmbedding(`${preparation.plan.question}\n${preparation.plan.sourceText}`);
      const learned = await this.prisma.$transaction(async (tx): Promise<ProductLearningTransactionResult> => {
        const renewedLease = lease
          ? await this.heartbeatProductLearningLease(tx, scope, shopId, jobId, lease)
          : undefined;
        const retained = await tx.productLearningJobItem.updateMany({
          where: { jobId, productId, ...this.scope(scope), shopId, status: 'PROCESSING' },
          data: { status: 'PROCESSING' },
        });
        if (retained.count !== 1) {
          return { outcome: 'SKIPPED', ...(renewedLease ? { lease: renewedLease } : {}) };
        }
        const product = await tx.product.findFirst({
          where: { id: productId, ...this.scope(scope), shopId, status: { not: 'DELETED' } },
          select: { id: true, title: true, description: true },
        });
        if (!product) {
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'FAILED', 'PRODUCT_NOT_FOUND'),
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        const sourceText = buildProductKnowledgeSource(product);
        const question = `商品「${product.title}」的稳定材质、功能和使用说明是什么？`;
        if (
          !sourceText ||
          sourceText !== preparation.plan!.sourceText ||
          question !== preparation.plan!.question ||
          this.hash(sourceText) !== preparation.plan!.contentHash
        ) {
          throw this.knowledgeVersionChangedRetry();
        }
        const existing = await tx.knowledgeItem.findFirst({
          where: {
            ...this.scope(scope),
            shopId,
            productId,
            scope: 'PRODUCT',
            sourceType: 'AUTO_LEARNED',
            deletedAt: null,
          },
          include: { versions: { where: { ...this.scope(scope), item: { shopId } }, orderBy: { version: 'desc' } } },
          orderBy: { updatedAt: 'desc' },
        });
        const active = existing?.versions.find((version) => version.id === existing.activeVersionId) ?? existing?.versions[0];
        if (
          (existing?.id ?? null) !== preparation.plan!.knowledgeItemId ||
          (existing?.activeVersionId ?? null) !== preparation.plan!.activeVersionId ||
          (active?.id ?? null) !== preparation.plan!.sourceVersionId
        ) {
          throw this.knowledgeVersionChangedRetry();
        }
        if (!existing) {
          const item = await tx.knowledgeItem.create({
            data: {
              ...this.scope(scope),
              shopId,
              productId,
              seedKey: `product-learning:${product.id}`,
              scope: 'PRODUCT',
              sourceType: 'AUTO_LEARNED',
              businessStatus: 'ENABLED',
            },
          });
          const version = await this.createReadyVersion(
            tx, scope, shopId, item.id, 1, question, sourceText, preparation.plan!.contentHash,
            null, 0.95, 'product-learning', embedding,
          );
          const switched = await tx.knowledgeItem.updateMany({
            where: { id: item.id, ...this.scope(scope), shopId, activeVersionId: null },
            data: { activeVersionId: version.id },
          });
          if (switched.count !== 1) throw this.knowledgeVersionChangedRetry();
          await tx.product.updateMany({ where: { id: product.id, ...this.scope(scope), shopId }, data: { activeKnowledgeVersionId: version.id } });
          return {
            outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'SUCCEEDED', 'CREATED'),
            source: { productId: product.id, title: product.title, sourceText },
            ...(renewedLease ? { lease: renewedLease } : {}),
          };
        }
        const now = new Date();
        const version = await this.createReadyVersion(
          tx,
          scope,
          shopId,
          existing.id,
          (existing.versions[0]?.version ?? 0) + 1,
          question,
          sourceText,
          preparation.plan!.contentHash,
          active?.id ?? null,
          0.95,
          'product-learning',
          embedding,
        );
        if (active) {
          await tx.knowledgeVersion.updateMany({
            where: { id: active.id, ...this.scope(scope), knowledgeItemId: existing.id, item: { shopId } },
            data: { effectiveTo: now },
          });
        }
        const switched = await tx.knowledgeItem.updateMany({
          where: { id: existing.id, ...this.scope(scope), shopId, activeVersionId: preparation.plan!.activeVersionId },
          data: { activeVersionId: version.id, businessStatus: 'ENABLED' },
        });
        if (switched.count !== 1) throw this.knowledgeVersionChangedRetry();
        await tx.product.updateMany({ where: { id: product.id, ...this.scope(scope), shopId }, data: { activeKnowledgeVersionId: version.id } });
        return {
          outcome: await this.finishLearningItem(tx, scope, shopId, jobId, productId, 'SUCCEEDED', 'UPDATED'),
          source: { productId: product.id, title: product.title, sourceText },
          ...(renewedLease ? { lease: renewedLease } : {}),
        };
      });
      if (lease && learned.lease) lease.updatedAt = learned.lease.updatedAt;
      if (learned.source) await this.extractProductFaqCandidate(scope, shopId, learned.source);
      return learned.outcome;
    } catch (error) {
      if (error instanceof ProductLearningLeaseLostError) throw error;
      if (lease) {
        let renewedLease: ProductLearningLease | undefined;
        try {
          await this.prisma.$transaction(async (tx) => {
            renewedLease = await this.heartbeatProductLearningLease(tx, scope, shopId, jobId, lease);
            await tx.productLearningJobItem.updateMany({
              where: { jobId, productId, ...this.scope(scope), shopId },
              data: { status: 'FAILED', reason: 'LEARNING_TRANSACTION_FAILED' },
            });
          });
        } catch (retryError) {
          if (retryError instanceof ProductLearningLeaseLostError) throw retryError;
          throw retryError;
        }
        if (renewedLease) lease.updatedAt = renewedLease.updatedAt;
      } else {
        await this.prisma.productLearningJobItem.updateMany({
          where: { jobId, productId, ...this.scope(scope), shopId },
          data: { status: 'FAILED', reason: 'LEARNING_TRANSACTION_FAILED' },
        });
      }
      return 'FAILED';
    }
  }

  /**
   * A generated FAQ is never promoted directly. Source-backed stable facts
   * above are high-confidence AUTO_LEARNED knowledge; this structured model
   * output is deliberately a PENDING AUTO_FAQ candidate for human review.
   */
  private async extractProductFaqCandidate(
    scope: WorkspaceScope,
    shopId: string,
    source: ProductLearningSource,
  ): Promise<void> {
    if (!this.aiRuntime) return;
    try {
      const result = await this.aiRuntime.runStructured<ProductFaqExtraction>(
        { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId },
        {
          purpose: 'KNOWLEDGE_EXTRACT',
          schema: 'KnowledgeCandidate',
          context: {
            product: {
              id: source.productId,
              title: source.title,
              stableSourceText: source.sourceText,
            },
          },
          allowedDataClasses: ['product'],
          promptVersion: 'product-learning-knowledge-extract-v1',
          evidence: [],
          ragStrategy: 'NONE',
        },
      );
      const candidate = result.output;
      const question = candidate.question?.trim() ?? '';
      const answer = candidate.answer?.trim() ?? '';
      // The model cannot select a different product or smuggle dynamic/PII
      // facts into a candidate. It may only propose reviewable stable FAQ.
      if (
        !candidate.shouldCreate ||
        candidate.scope !== 'PRODUCT' ||
        (candidate.productId !== undefined && candidate.productId !== null && candidate.productId !== source.productId) ||
        !question ||
        !answer ||
        candidate.containsPII ||
        candidate.containsTemporaryCommitment ||
        this.containsKnowledgePII(question, answer) ||
        containsDynamicCommerceFact(`${question}\n${answer}`)
      ) {
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.findFirst({
          where: { id: source.productId, ...this.scope(scope), shopId, status: { not: 'DELETED' } },
          select: { id: true },
        });
        if (!product) return;
        const existing = await tx.knowledgeCandidate.findFirst({
          where: {
            ...this.scope(scope),
            shopId,
            productId: source.productId,
            source: 'AUTO_FAQ',
            proposedQuestion: question,
            proposedAnswer: answer,
            status: 'PENDING',
          },
          select: { id: true },
        });
        if (existing) return;
        await tx.knowledgeCandidate.create({
          data: {
            ...this.scope(scope),
            shopId,
            productId: source.productId,
            source: 'AUTO_FAQ',
            proposedQuestion: question,
            proposedAnswer: answer,
            status: 'PENDING',
          },
        });
      });
    } catch {
      // Source facts are already committed. Candidate generation is advisory
      // and uses the same offline/configured runtime boundary as other Phase
      // 03 structured calls; it must not turn a successful learning item into
      // a failure.
    }
  }

  private async finishLearningItem(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    jobId: string,
    productId: string,
    status: 'SUCCEEDED' | 'FAILED',
    reason: string,
  ): Promise<'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED'> {
    await tx.productLearningJobItem.updateMany({
      where: { jobId, productId, ...this.scope(scope), shopId },
      data: { status, reason },
    });
    if (status === 'FAILED') return 'FAILED';
    return reason === 'CREATED' ? 'CREATED' : reason === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
  }

  private async createReadyVersion(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    knowledgeItemId: string,
    version: number,
    question: string,
    answer: string,
    contentHash: string,
    supersedesId: string | null,
    confidence: number,
    sourceVersion: string,
    embedding: PreparedEmbedding,
  ) {
    // This is the second write boundary for create/revise/approve flows.
    // Callers validate their request first; this protects the actual version
    // insert from a stale or mutated value inside the transaction.
    this.assertKnowledgeText(question, answer);
    const sourceText = `${question}\n${answer}`;
    const prepared = this.requirePreparedEmbedding(embedding, sourceText);
    const now = new Date();
    const indexing = await tx.knowledgeVersion.create({
      data: {
        ...this.scope(scope),
        knowledgeItemId,
        version,
        question,
        answer,
        sourceText,
        sourceVersion,
        confidence,
        indexStatus: 'INDEXING',
        contentHash,
        ...(supersedesId ? { supersedesId } : {}),
        effectiveFrom: now,
      },
    });
    await this.persistScopedEmbedding(tx, scope, shopId, knowledgeItemId, indexing.id, prepared);
    const readyUpdated = await tx.knowledgeVersion.updateMany({
      where: { id: indexing.id, ...this.scope(scope), knowledgeItemId, item: { shopId }, indexStatus: 'INDEXING' },
      data: { indexStatus: 'READY', indexedAt: now, searchTokensJson: tokenizeKnowledge(sourceText) },
    });
    if (readyUpdated.count !== 1) throw this.knowledgeIndexWriteConflict();
    const ready = await tx.knowledgeVersion.findFirst({
      where: { id: indexing.id, ...this.scope(scope), knowledgeItemId, item: { shopId } },
    });
    if (!ready) throw badRequest('KNOWLEDGE_INDEX_FAILED', 'Knowledge version was not indexed');
    return ready;
  }

  private async commitRow(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    importId: string,
    row: KnowledgeImportRow,
    embedding?: PreparedEmbedding,
  ): Promise<void> {
    // Preview's ERROR state is not trusted as the only guard: a row can be
    // retried or changed between preview and commit.
    const policyViolation = this.importTextViolation(row.question, row.answer);
    if (policyViolation) {
      await this.updateImportRow(tx, scope, shopId, row.id, 'ERROR', policyViolation);
      return;
    }
    if (row.scope === 'PRODUCT') {
      const product = await tx.product.findFirst({
        where: { id: row.productId ?? '', ...this.scope(scope), shopId },
        select: { id: true },
      });
      if (!product) {
        await this.updateImportRow(tx, scope, shopId, row.id, 'ERROR', 'PRODUCT_NOT_FOUND_IN_THIS_SHOP');
        return;
      }
    }
    const previous = await tx.knowledgeItem.findMany({
      where: {
        ...this.scope(scope),
        shopId,
        scope: row.scope,
        productId: row.scope === 'PRODUCT' ? row.productId : null,
        deletedAt: null,
        // Only currently enabled facts can block a human candidate. Resolved
        // conflict sides are intentionally excluded so MERGE/CUSTOM candidates
        // may later be approved through their separate human action.
        businessStatus: 'ENABLED',
      },
      include: { versions: { where: this.scope(scope), select: { question: true, answer: true } } },
    });
    const answers = previous.flatMap((item) =>
      item.versions.filter((version) => knowledgeFingerprint(version.question) === (row.fingerprint ?? knowledgeFingerprint(row.question))).map((version) => version.answer),
    );
    const decision = classifyImportRow(
      {
        rowNumber: row.rowNumber,
        scope: row.scope,
        productExternalId: row.productExternalId,
        question: row.question,
        answer: row.answer,
      },
      answers,
    );
    if (decision.status !== 'VALID') {
      await this.updateImportRow(tx, scope, shopId, row.id, decision.status, decision.reason ?? 'IMPORT_ROW_NOT_ELIGIBLE');
      return;
    }
    const now = new Date();
    const item = await tx.knowledgeItem.create({
      data: {
        ...this.scope(scope),
        shopId,
        productId: row.scope === 'PRODUCT' ? row.productId : null,
        seedKey: `import:${importId}:${row.rowNumber}`,
        scope: row.scope,
        sourceType: 'MANUAL',
        businessStatus: 'ENABLED',
      },
    });
    const sourceText = `${row.question}\n${row.answer}`;
    const prepared = this.requirePreparedEmbedding(embedding, sourceText);
    const version = await this.createReadyVersion(
      tx,
      scope,
      shopId,
      item.id,
      1,
      row.question,
      row.answer,
      this.hash(sourceText),
      null,
      1,
      `import:${importId}`,
      prepared,
    );
    const activated = await tx.knowledgeItem.updateMany({
      where: { id: item.id, ...this.scope(scope), shopId, activeVersionId: null },
      data: { activeVersionId: version.id },
    });
    if (activated.count !== 1) throw this.knowledgeVersionChangedRetry();
    await tx.knowledgeImportRow.updateMany({
      where: { id: row.id, ...this.scope(scope), shopId },
      data: { status: 'COMMITTED', reason: null, committedKnowledgeItemId: item.id, committedAt: now },
    });
  }

  private async findQuestionMatchRecords(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    knowledgeScope: KnowledgeScopeValue,
    productId: string | null,
    question: string,
    excludeKnowledgeId?: string,
  ): Promise<QuestionMatch[]> {
    const now = new Date();
    const items = await tx.knowledgeItem.findMany({
      where: {
        ...this.scope(scope),
        shopId,
        scope: knowledgeScope,
        productId: knowledgeScope === 'PRODUCT' ? productId : null,
        deletedAt: null,
        // Only currently enabled facts can block a human candidate. Resolved
        // conflict sides are intentionally excluded so MERGE/CUSTOM candidates
        // may later be approved through their separate human action.
        businessStatus: 'ENABLED',
        ...(excludeKnowledgeId ? { id: { not: excludeKnowledgeId } } : {}),
      },
      include: {
        versions: {
          where: {
            ...this.scope(scope),
            item: { shopId },
            indexStatus: 'READY',
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          select: { id: true, question: true, answer: true },
        },
      },
    });
    const fingerprint = knowledgeFingerprint(question);
    return items.flatMap((item) =>
      item.versions
        .filter(
          (version) => version.id === item.activeVersionId && knowledgeFingerprint(version.question) === fingerprint,
        )
        .map((version) => ({ itemId: item.id, versionId: version.id, answer: version.answer })),
    );
  }

  private async recordExplicitConflict(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    item: Pick<KnowledgeItem, 'id' | 'productId'>,
    version: Pick<KnowledgeVersion, 'id' | 'question' | 'answer'>,
    conflicting: readonly QuestionMatch[],
    source: string,
  ) {
    for (const existing of conflicting) {
      await tx.knowledgeConflict.create({
        data: {
          ...this.scope(scope),
          shopId,
          leftItemId: item.id,
          rightItemId: existing.itemId,
          leftVersionId: version.id,
          rightVersionId: existing.versionId,
          status: 'OPEN',
        },
      });
    }
    const first = conflicting[0];
    if (!first) return;
    await tx.knowledgeCandidate.create({
      data: {
        ...this.scope(scope),
        shopId,
        productId: item.productId,
        source,
        proposedQuestion: version.question,
        proposedAnswer: version.answer,
        status: 'CONFLICTED',
        conflictWithId: first.itemId,
      },
    });
  }

  private async markConflictResolved(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    conflictId: string,
    resolution: Record<string, string>,
  ) {
    const updated = await tx.knowledgeConflict.updateMany({
      where: { id: conflictId, ...this.scope(scope), shopId, status: 'OPEN' },
      data: {
        status: 'RESOLVED',
        resolvedBy: 'HUMAN_REVIEW',
        resolvedAt: new Date(),
        resolutionJson: resolution as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) throw new ConflictException({ code: 'KNOWLEDGE_CONFLICT_CLAIM_LOST', message: 'Knowledge conflict changed during resolution' });
  }

  private async persistScopedEmbedding(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    knowledgeItemId: string,
    versionId: string,
    embedding: PreparedEmbedding,
  ) {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "KnowledgeVersion" AS "version"
      SET "embedding" = ${embedding.vector}::vector
      FROM "KnowledgeItem" AS "item"
      WHERE "version"."id" = ${versionId}
        AND "version"."knowledgeItemId" = ${knowledgeItemId}
        AND "version"."workspaceId" = ${scope.workspaceId}
        AND "version"."tenantId" = ${scope.tenantId}
        AND "version"."indexStatus" = 'INDEXING'
        AND "item"."id" = "version"."knowledgeItemId"
        AND "item"."workspaceId" = ${scope.workspaceId}
        AND "item"."tenantId" = ${scope.tenantId}
        AND "item"."shopId" = ${shopId}
    `);
    if (updated !== 1) throw this.knowledgeIndexWriteConflict();
  }

  private async findScopedVectorScores(
    scope: WorkspaceScope,
    input: KnowledgeSearchInput,
    now: Date,
  ): Promise<Map<string, number>> {
    // The conditional is only for deliberately lightweight unit fakes. A real
    // Prisma client always has $queryRaw and will surface a broken pgvector
    // migration instead of silently weakening production isolation.
    if (typeof this.prisma.$queryRaw !== 'function') return new Map();
    const queryEmbedding = pgVectorLiteral(await this.embeddingProvider().embed(this.sanitizeEmbeddingText(input.query)));
    const productId = input.productId ?? null;
    const rows = await this.prisma.$queryRaw<VectorScoreRow[]>(Prisma.sql`
      SELECT
        "version"."knowledgeItemId" AS "knowledgeItemId",
        "version"."id" AS "versionId",
        (1 - ("version"."embedding" <=> ${queryEmbedding}::vector))::double precision AS "vectorScore"
      FROM "KnowledgeVersion" AS "version"
      INNER JOIN "KnowledgeItem" AS "item" ON "item"."id" = "version"."knowledgeItemId"
      WHERE "version"."workspaceId" = ${scope.workspaceId}
        AND "version"."tenantId" = ${scope.tenantId}
        AND "item"."workspaceId" = ${scope.workspaceId}
        AND "item"."tenantId" = ${scope.tenantId}
        AND "item"."shopId" = ${input.shopId}
        AND "item"."deletedAt" IS NULL
        AND "version"."indexStatus" = 'READY'
        AND "version"."embedding" IS NOT NULL
        AND "version"."effectiveFrom" <= ${now}
        AND ("version"."effectiveTo" IS NULL OR "version"."effectiveTo" > ${now})
        AND (
          ("item"."scope" = 'STORE' AND "item"."productId" IS NULL)
          OR (${productId}::text IS NOT NULL AND "item"."scope" = 'PRODUCT' AND "item"."productId" = ${productId}::text)
        )
      ORDER BY "version"."embedding" <=> ${queryEmbedding}::vector ASC
      LIMIT 50
    `);
    return new Map(
      rows
        .filter((row) => typeof row.vectorScore === 'number' && Number.isFinite(row.vectorScore))
        .map((row) => [`${row.knowledgeItemId}:${row.versionId}`, Math.max(0, Math.min(1, row.vectorScore ?? 0))]),
    );
  }

  private async updateImportRow(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    rowId: string,
    status: 'DUPLICATE' | 'CONFLICT' | 'ERROR',
    reason: string,
  ) {
    return tx.knowledgeImportRow.updateMany({
      where: { id: rowId, ...this.scope(scope), shopId },
      data: { status, reason },
    });
  }

  private toRagCandidates(
    items: Array<KnowledgeItem & { versions: KnowledgeVersion[] }>,
    mode: 'normal' | 'conflict',
    vectorScores: ReadonlyMap<string, number>,
    explicitConflictVersionIds = new Set<string>(),
  ): RagCandidate[] {
    return items.flatMap((item) => {
      if (mode === 'normal' && item.businessStatus !== 'ENABLED') return [];
      const versions =
        mode === 'normal'
          ? item.versions.filter((version) => version.id === item.activeVersionId)
          : item.versions.filter((version) => explicitConflictVersionIds.has(version.id));
      return versions.map((version) => ({
        id: `${item.id}:${version.id}`,
        itemId: item.id,
        versionId: version.id,
        version: version.version,
        workspaceId: item.workspaceId,
        tenantId: item.tenantId,
        shopId: item.shopId,
        scope: item.scope,
        productId: item.productId,
        businessStatus: item.businessStatus,
        indexStatus: version.indexStatus,
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
        question: version.question,
        answer: version.answer,
        sourceType: item.sourceType,
        ...(vectorScores.has(`${item.id}:${version.id}`) ? { vectorScore: vectorScores.get(`${item.id}:${version.id}`) } : {}),
      }));
    });
  }

  private itemView(item: KnowledgeItem & { versions: KnowledgeVersion[] }) {
    const active = item.versions.find((version) => version.id === item.activeVersionId) ?? null;
    return {
      id: item.id,
      shopId: item.shopId,
      productId: item.productId,
      scope: item.scope,
      sourceType: item.sourceType,
      businessStatus: item.businessStatus,
      activeVersionId: item.activeVersionId,
      deletedAt: item.deletedAt?.toISOString() ?? null,
      activeVersion: active ? this.versionView(active) : null,
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private versionView(version: KnowledgeVersion) {
    return {
      id: version.id,
      version: version.version,
      question: version.question,
      answer: version.answer,
      indexStatus: version.indexStatus,
      confidence: version.confidence,
      effectiveFrom: version.effectiveFrom.toISOString(),
      effectiveTo: version.effectiveTo?.toISOString() ?? null,
      indexedAt: version.indexedAt?.toISOString() ?? null,
    };
  }

  private candidateView(candidate: KnowledgeCandidate) {
    return {
      id: candidate.id,
      shopId: candidate.shopId,
      productId: candidate.productId,
      source: candidate.source,
      proposedQuestion: candidate.proposedQuestion,
      proposedAnswer: candidate.proposedAnswer,
      status: candidate.status,
      duplicateOfId: candidate.duplicateOfId,
      conflictWithId: candidate.conflictWithId,
      updatedAt: candidate.updatedAt.toISOString(),
    };
  }

  private async conflictViews(scope: WorkspaceScope, conflicts: KnowledgeConflict[], scopedShopId?: string) {
    if (conflicts.length === 0) return [];
    const versionIds = [...new Set(conflicts.flatMap((conflict) => [conflict.leftVersionId, conflict.rightVersionId]))];
    const shops = [...new Set(conflicts.map((conflict) => conflict.shopId))];
    const versions = await this.prisma.knowledgeVersion.findMany({
      where: {
        ...this.scope(scope),
        id: { in: versionIds },
        item: { shopId: scopedShopId ?? { in: shops } },
      },
      select: { id: true, knowledgeItemId: true, version: true, question: true, answer: true, indexStatus: true },
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    return conflicts.map((conflict) => this.conflictView(conflict, byId));
  }

  private conflictView(
    conflict: KnowledgeConflict,
    versions: ReadonlyMap<string, { id: string; knowledgeItemId: string; version: number; question: string; answer: string; indexStatus: string }>,
  ) {
    const left = versions.get(conflict.leftVersionId);
    const right = versions.get(conflict.rightVersionId);
    if (!left || !right || left.knowledgeItemId !== conflict.leftItemId || right.knowledgeItemId !== conflict.rightItemId) {
      throw badRequest('KNOWLEDGE_CONFLICT_VERSION_SNAPSHOT_MISSING', 'Conflict version snapshot is not available in this scope');
    }
    return {
      id: conflict.id,
      shopId: conflict.shopId,
      leftItemId: conflict.leftItemId,
      rightItemId: conflict.rightItemId,
      leftVersionId: conflict.leftVersionId,
      rightVersionId: conflict.rightVersionId,
      left: {
        versionId: left.id,
        itemId: left.knowledgeItemId,
        version: left.version,
        question: left.question,
        answer: left.answer,
        indexStatus: left.indexStatus,
      },
      right: {
        versionId: right.id,
        itemId: right.knowledgeItemId,
        version: right.version,
        question: right.question,
        answer: right.answer,
        indexStatus: right.indexStatus,
      },
      status: conflict.status,
      resolution: conflict.resolutionJson,
      resolvedAt: conflict.resolvedAt?.toISOString() ?? null,
      updatedAt: conflict.updatedAt.toISOString(),
    };
  }

  private importView(imported: KnowledgeImport & { rows: KnowledgeImportRow[] }) {
    return {
      id: imported.id,
      shopId: imported.shopId,
      status: imported.status,
      totals: {
        total: imported.totalRows,
        valid: imported.validRows,
        duplicate: imported.duplicateRows,
        conflict: imported.conflictRows,
        error: imported.errorRows,
      },
      committedAt: imported.committedAt?.toISOString() ?? null,
      rows: imported.rows.map((row) => ({
        rowNumber: row.rowNumber,
        scope: row.scope,
        productId: row.productId,
        productExternalId: row.productExternalId,
        question: row.question,
        answer: row.answer,
        status: row.status,
        reason: row.reason,
        committedKnowledgeItemId: row.committedKnowledgeItemId,
      })),
    };
  }

  private productLearningJobView(job: {
    id: string;
    shopId: string;
    status: string;
    totalProducts: number;
    createdProducts: number;
    updatedProducts: number;
    skippedProducts: number;
    failedProducts: number;
    items: Array<{ productId: string; status: string; reason: string | null }>;
  }) {
    return {
      id: job.id,
      shopId: job.shopId,
      status: job.status,
      totals: {
        total: job.totalProducts,
        created: job.createdProducts,
        updated: job.updatedProducts,
        skipped: job.skippedProducts,
        failed: job.failedProducts,
      },
      items: job.items.map((item) => ({ productId: item.productId, status: item.status, reason: item.reason })),
    };
  }

  private scopeSelector(scope: KnowledgeScopeInput, productId?: string): Prisma.KnowledgeItemWhereInput {
    if (scope === 'STORE') return { scope: 'STORE', productId: null };
    if (scope === 'PRODUCT') return { scope: 'PRODUCT', productId: productId! };
    return productId
      ? { OR: [{ scope: 'STORE', productId: null }, { scope: 'PRODUCT', productId }] }
      : { scope: 'STORE', productId: null };
  }

  private assertScopeInput(input: { shopId: string; scope?: KnowledgeScopeInput; productId?: string }) {
    if (!input.shopId?.trim()) throw badRequest('SHOP_ID_REQUIRED', 'shopId is required');
    if (input.scope && input.scope !== 'STORE' && input.scope !== 'PRODUCT') {
      throw badRequest('KNOWLEDGE_SCOPE_INVALID', 'scope must be STORE or PRODUCT');
    }
    if (input.scope === 'PRODUCT' && !input.productId?.trim()) {
      throw badRequest('PRODUCT_ID_REQUIRED', 'productId is required for PRODUCT knowledge');
    }
  }

  private assertImportInput(input: KnowledgeImportInput) {
    if (!input?.shopId?.trim()) throw badRequest('SHOP_ID_REQUIRED', 'shopId is required');
    if (!input.csv?.trim() && !input.xlsx?.length) throw badRequest('IMPORT_SOURCE_REQUIRED', 'CSV or XLSX content is required');
    const byteLength = input.csv ? Buffer.byteLength(input.csv, 'utf8') : input.xlsx!.byteLength;
    if (byteLength > MAX_CSV_BYTES) {
      throw badRequest('IMPORT_SIZE_LIMIT_EXCEEDED', `Import may not exceed ${MAX_CSV_BYTES} bytes`);
    }
  }

  private assertKnowledgeText(question: string, answer: string) {
    if (!question?.trim() || !answer?.trim()) {
      throw badRequest('KNOWLEDGE_QUESTION_AND_ANSWER_REQUIRED', 'question and answer are required');
    }
    if (containsDynamicCommerceFact(`${question}\n${answer}`)) {
      throw badRequest('DYNAMIC_COMMERCE_FACT_FORBIDDEN', 'Dynamic price, inventory, and SKU facts cannot be indexed');
    }
    if (this.containsKnowledgePII(question, answer)) {
      throw badRequest('KNOWLEDGE_PII_FORBIDDEN', 'PII cannot be written to knowledge');
    }
  }

  /**
   * Keep the write policy on the shared sanitizer, so its PII patterns stay
   * identical to provider-context handling instead of trusting a model flag.
   */
  private containsKnowledgePII(...values: string[]): boolean {
    const input = Object.fromEntries(values.map((value, index) => [`knowledgeText${index}`, value]));
    return sanitizeContext(input, Object.keys(input)).audit.excludedPII.length > 0;
  }

  private importTextViolation(question: string, answer: string): string | undefined {
    if (!question?.trim() || !answer?.trim()) return 'KNOWLEDGE_QUESTION_AND_ANSWER_REQUIRED';
    if (containsDynamicCommerceFact(`${question}\n${answer}`)) return 'DYNAMIC_COMMERCE_FACT_FORBIDDEN';
    return this.containsKnowledgePII(question, answer) ? 'KNOWLEDGE_PII_FORBIDDEN' : undefined;
  }

  /** Testable clock seam for timeout/CAS state machines. */
  private now(): Date {
    return new Date();
  }

  /**
   * `updatedAt` is the only frozen-schema owner token. Keep it monotonic even
   * when several row heartbeats happen within one clock millisecond.
   */
  private nextLeaseTimestamp(previous?: Date): Date {
    const current = this.now();
    return previous && current.getTime() <= previous.getTime()
      ? new Date(previous.getTime() + 1)
      : current;
  }

  private async heartbeatImportLease(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    importId: string,
    lease: ImportCommitLease,
  ): Promise<ImportCommitLease> {
    const updatedAt = this.nextLeaseTimestamp(lease.updatedAt);
    const renewed = await tx.knowledgeImport.updateMany({
      where: {
        id: importId,
        ...this.scope(scope),
        shopId,
        status: 'COMMITTING',
        updatedAt: lease.updatedAt,
      },
      data: { status: 'COMMITTING', updatedAt },
    });
    if (renewed.count !== 1) throw new KnowledgeImportLeaseLostError();
    return { updatedAt };
  }

  private importLeaseLost(): ConflictException {
    return new ConflictException({
      code: 'KNOWLEDGE_IMPORT_LEASE_LOST',
      message: 'Knowledge import commit lease was taken over by another worker',
    });
  }

  private isProductLearningLeaseStale(
    job: { startedAt: Date | null; updatedAt: Date },
    staleBefore: Date,
  ): boolean {
    // A long-running healthy job refreshes updatedAt per item, so an old
    // startedAt alone must not make it stealable.
    const lastActivity = Math.max(job.startedAt?.getTime() ?? 0, job.updatedAt.getTime());
    return lastActivity <= staleBefore.getTime();
  }

  private async reclaimProductLearningJob(
    scope: WorkspaceScope,
    shopId: string,
    job: {
      id: string;
      status: ProductLearningJobStatus;
      updatedAt: Date;
    },
    staleBefore: Date,
    retryFailed: boolean,
  ): Promise<boolean> {
    const resetUpdatedAt = this.nextLeaseTimestamp(job.updatedAt);
    return this.prisma.$transaction(async (tx) => {
      const reset = await tx.productLearningJob.updateMany({
        where: {
          id: job.id,
          ...this.scope(scope),
          shopId,
          status: job.status,
          updatedAt: job.updatedAt,
        },
        data: { status: 'PENDING', startedAt: null, completedAt: null, updatedAt: resetUpdatedAt },
      });
      if (reset.count !== 1) return false;
      // A crashed worker can leave an item in PROCESSING forever. Only rows
      // whose own heartbeat expired are returned to the claimable queue.
      await tx.productLearningJobItem.updateMany({
        where: {
          jobId: job.id,
          ...this.scope(scope),
          shopId,
          status: 'PROCESSING',
          updatedAt: { lte: staleBefore },
        },
        data: { status: 'PENDING', reason: null },
      });
      if (retryFailed) {
        await tx.productLearningJobItem.updateMany({
          where: { jobId: job.id, ...this.scope(scope), shopId, status: 'FAILED' },
          data: { status: 'PENDING', reason: null },
        });
      }
      return true;
    });
  }

  private async heartbeatProductLearningLease(
    tx: Transaction,
    scope: WorkspaceScope,
    shopId: string,
    jobId: string,
    lease: ProductLearningLease,
  ): Promise<ProductLearningLease> {
    const updatedAt = this.nextLeaseTimestamp(lease.updatedAt);
    const renewed = await tx.productLearningJob.updateMany({
      where: {
        id: jobId,
        ...this.scope(scope),
        shopId,
        status: 'RUNNING',
        updatedAt: lease.updatedAt,
      },
      data: { status: 'RUNNING', updatedAt },
    });
    if (renewed.count !== 1) throw new ProductLearningLeaseLostError();
    return { updatedAt };
  }

  private async currentProductLearningJobView(scope: WorkspaceScope, jobId: string, shopId: string) {
    const current = await this.prisma.productLearningJob.findFirst({
      where: { id: jobId, ...this.scope(scope), shopId },
      include: { items: { where: { ...this.scope(scope), shopId }, orderBy: { productId: 'asc' } } },
    });
    if (!current) throw notFound('PRODUCT_LEARNING_JOB_NOT_FOUND', 'Product learning job not found in this Workspace');
    return this.productLearningJobView(current);
  }

  private async assertShop(scope: WorkspaceScope, shopId: string): Promise<void> {
    const shop = await this.prisma.shop.findFirst({ where: { id: shopId, ...this.scope(scope) }, select: { id: true } });
    if (!shop) throw notFound('SHOP_NOT_FOUND', 'Shop not found in this Workspace');
  }

  /**
   * Entity-id routes derive shop ownership server-side. An optional supplied
   * shop id is only an anti-confusion assertion, never an authorization input.
   */
  private async resolveKnowledgeShop(scope: WorkspaceScope, knowledgeId: string, expectedShopId?: string): Promise<string> {
    const item = await this.prisma.knowledgeItem.findFirst({
      where: { id: knowledgeId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!item || (expectedShopId?.trim() && item.shopId !== expectedShopId)) {
      throw notFound('KNOWLEDGE_NOT_FOUND', 'Knowledge item not found in this Workspace');
    }
    return item.shopId;
  }

  private async resolveImportShop(scope: WorkspaceScope, importId: string, expectedShopId?: string): Promise<string> {
    const imported = await this.prisma.knowledgeImport.findFirst({
      where: { id: importId, ...this.scope(scope) },
      select: { shopId: true },
    });
    if (!imported || (expectedShopId?.trim() && imported.shopId !== expectedShopId)) {
      throw notFound('KNOWLEDGE_IMPORT_NOT_FOUND', 'Knowledge import not found in this Workspace');
    }
    return imported.shopId;
  }

  private async assertProduct(scope: WorkspaceScope, shopId: string, productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, ...this.scope(scope), shopId },
      select: { id: true },
    });
    if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Product not found in this Workspace/shop');
  }

  private scope(scope: WorkspaceScope): { workspaceId: string; tenantId: string } {
    return { workspaceId: scope.workspaceId, tenantId: scope.tenantId };
  }

  private embeddingProvider(): KnowledgeEmbeddingProvider {
    return this.configuredEmbeddingProvider ?? deterministicOfflineEmbeddingProvider;
  }

  /**
   * Resolve the entire provider boundary before a write transaction begins.
   * Keeping the original source alongside the vector makes accidental reuse
   * across a concurrently changed version detectable at the final CAS.
   */
  private async prepareEmbedding(sourceText: string): Promise<PreparedEmbedding> {
    const vector = await this.embeddingProvider().embed(this.sanitizeEmbeddingText(sourceText));
    return { sourceText, vector: pgVectorLiteral(vector) };
  }

  private requirePreparedEmbedding(embedding: PreparedEmbedding | undefined, sourceText: string): PreparedEmbedding {
    if (!embedding || embedding.sourceText !== sourceText) throw this.knowledgeVersionChangedRetry();
    return embedding;
  }

  private knowledgeVersionChangedRetry(): ConflictException {
    return new ConflictException({
      code: 'KNOWLEDGE_VERSION_CHANGED_RETRY',
      message: 'Knowledge version changed while indexing; retry the operation',
    });
  }

  private knowledgeIndexWriteConflict(): ConflictException {
    return new ConflictException({
      code: 'KNOWLEDGE_INDEX_WRITE_CONFLICT',
      message: 'Knowledge index target changed before it could be made ready',
    });
  }

  private sanitizeEmbeddingText(value: string): string {
    const sanitized = sanitizeContext({ embeddingText: value }, ['embeddingText']).value.embeddingText;
    return typeof sanitized === 'string' ? sanitized : '';
  }

  private publishKnowledge(
    scope: WorkspaceScope,
    shopId: string,
    knowledgeId: string,
    payload: { businessStatus?: string; indexStatus?: string } = {},
  ): void {
    try {
      this.gateway?.publish({
        eventId: randomUUID(),
        eventType: 'KNOWLEDGE_UPDATED',
        workspaceId: scope.workspaceId,
        entityType: 'KNOWLEDGE',
        entityId: knowledgeId,
        entityVersion: Date.now(),
        occurredAt: new Date().toISOString(),
        payload: { shopId, knowledgeId, ...payload },
      });
    } catch {
      // DB is canonical; reconnect/event consumers refresh the REST snapshot.
    }
  }

  private publishProduct(
    scope: WorkspaceScope,
    shopId: string,
    productId: string,
    learningStatus?: string,
  ): void {
    try {
      this.gateway?.publish({
        eventId: randomUUID(),
        eventType: 'PRODUCT_UPDATED',
        workspaceId: scope.workspaceId,
        entityType: 'PRODUCT',
        entityId: productId,
        entityVersion: Date.now(),
        occurredAt: new Date().toISOString(),
        payload: { shopId, productId, ...(learningStatus ? { learningStatus } : {}) },
      });
    } catch {
      // Advisory push failure cannot roll back a committed product mutation.
    }
  }

  private questionKey(scope: KnowledgeScopeValue, productId: string | null, question: string): string {
    return `${scope}:${productId ?? '-'}:${knowledgeFingerprint(question)}`;
  }

  private hash(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

function notFound(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}
