/** Response normalizers and client-side validation for the frozen demo contracts. */

import type {
  ActionProposal,
  Conversation,
  CustomerDataDeletionResult,
  CustomerMemory,
  CustomerMemoryStatusResult,
  DeveloperTrace,
  ExistingKnowledgeMatch,
  HumanFinalReceipt,
  KnowledgeBusinessStatus,
  KnowledgeCandidate,
  KnowledgeCandidateStatus,
  KnowledgeConflict,
  KnowledgeConflictSideSnapshot,
  KnowledgeImportPreview,
  KnowledgeImportRow,
  KnowledgeImportRowInput,
  KnowledgeImportRowStatus,
  KnowledgeIndexStatus,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSourceType,
  KnowledgeVersionSnapshot,
  NodeRun,
  OperationAccepted,
  ProductLearningJob,
  ProductLearningJobStatus,
  ProductLearningJobItem,
  ProductLearningStatus,
  QualityResult,
  QualityReview,
  ReplyDraft,
  ReplyIncident,
  ReplyJob,
  Scenario,
  SendOutbox,
  SyntheticDynamicFactAccepted,
  SyntheticDynamicFactOrderStatus,
  TraceEvent,
  Workflow,
  WorkflowGraph,
  WorkflowRun,
  WorkflowVersion,
} from '../types';

import type {
  ActionProposal as ActionProposalContract,
  IncidentSeverity,
  IncidentStatus,
  Message as MessageContract,
  OperationAccepted as OperationAcceptedContract,
  QualityReview as QualityReviewContract,
  ScenarioKey,
  TraceEvent as TraceEventContract,
  WorkflowGraph as WorkflowGraphContract,
} from '@ai-customer-service/contracts';

import { ApiError, extractEntity, readTextValue, stringValue } from '../client';

import {
  ASSIST_DRAFT_TTL_MS, actionProposalStatuses, actionProposalTypes, actionRiskLevels, hasOwn,
  isActionProposal, isOperationAccepted, isQualityReview, isScenarioKey, isTraceEvent, isWorkflowGraph,
  nullableStringValue, numberValue, objectRecord, qualityResults, scenarioKeys, workflowNodeRunStatuses,
  workflowRunStatuses, normalizeCsvHeader, parseCsvRecords,
} from './shared';

export function parseKnowledgeCsv(csv: string): KnowledgeImportRowInput[] {
  const records = parseCsvRecords(csv);
  const header = records[0]?.map(normalizeCsvHeader) ?? [];
  const acceptedProductHeaders = new Set(['商品id（可选）', '商品id(可选)', '商品id', 'productid', 'product']);
  const acceptedQuestionHeaders = new Set(['问题', 'question', 'q']);
  const acceptedAnswerHeaders = new Set(['答案', 'answer', 'a']);
  const hasExpectedHeader = acceptedProductHeaders.has(header[0] ?? '') && acceptedQuestionHeaders.has(header[1] ?? '') && acceptedAnswerHeaders.has(header[2] ?? '');
  const sourceRows = hasExpectedHeader ? records.slice(1) : records;
  if (!hasExpectedHeader) {
    return [{ rowNumber: 1, productId: '', question: '', answer: '', parseError: '表头必须为：商品ID（可选）、问题、答案' }];
  }

  return sourceRows.map((values, index) => ({
    rowNumber: index + 2,
    productId: (values[0] ?? '').trim(),
    question: (values[1] ?? '').trim(),
    answer: values.slice(2).join(',').trim(),
    ...(values.length !== 3 ? { parseError: '每行必须包含三列' } : {}),
  }));
}

function importKey(productId: string, question: string): string {
  return `${productId.trim().toLowerCase() || 'store'}::${question.trim().toLowerCase()}`;
}

export function classifyImportRows(
  rows: KnowledgeImportRowInput[],
  existing: ExistingKnowledgeMatch[] = [],
): KnowledgeImportRow[] {
  const existingByKey = new Map(existing.map((item) => [importKey(item.productId ?? '', item.question), item]));
  const seen = new Map<string, KnowledgeImportRow>();
  return rows.map((row) => {
    const scope: KnowledgeScope = row.productId ? 'PRODUCT' : 'STORE';
    if (row.parseError || !row.question || !row.answer) {
      const result: KnowledgeImportRow = { ...row, scope, status: 'ERROR', reason: row.parseError ?? '问题和答案不能为空' };
      seen.set(importKey(row.productId, row.question), result);
      return result;
    }

    const key = importKey(row.productId, row.question);
    const previous = seen.get(key);
    const existingMatch = existingByKey.get(key);
    let status: KnowledgeImportRowStatus = 'READY';
    let reason: string | undefined;
    if ((previous && previous.answer !== row.answer) || (existingMatch && existingMatch.answer !== row.answer)) {
      status = 'CONFLICT';
      reason = '相同问题已有不同答案';
    } else if (previous || existingMatch) {
      status = 'DUPLICATE';
      reason = '与已有知识或本文件重复';
    }
    const result: KnowledgeImportRow = { ...row, scope, status, ...(reason ? { reason } : {}) };
    seen.set(key, result);
    return result;
  });
}

export function normalizeImportPreview(payload: unknown): KnowledgeImportPreview {
  const preview = extractEntity<Partial<KnowledgeImportPreview>>(payload, 'preview');
  const rawPreview = preview as Partial<KnowledgeImportPreview> & Record<string, unknown>;
  const sourceRows = Array.isArray(preview?.rows) ? preview.rows : [];
  const rows = sourceRows.map((row, index) => {
    const rawRow = row as KnowledgeImportRow & { result?: string; error?: string };
    const result = String(rawRow.status ?? rawRow.result ?? (rawRow.error ? 'ERROR' : 'READY')).toUpperCase();
    const status: KnowledgeImportRowStatus = result === 'NORMAL' || result === 'VALID' || result === 'READY' || result === 'COMMITTED'
      ? 'READY'
      : result === 'DUPLICATE'
        ? 'DUPLICATE'
        : result === 'CONFLICT' || result === 'CONFLICTED'
          ? 'CONFLICT'
          : 'ERROR';
    return {
      rowNumber: typeof rawRow.rowNumber === 'number' ? rawRow.rowNumber : index + 1,
      productId: String(rawRow.productId ?? ''),
      question: String(rawRow.question ?? ''),
      answer: String(rawRow.answer ?? ''),
      scope: rawRow.scope === 'PRODUCT' || rawRow.productId ? 'PRODUCT' : 'STORE',
      status,
      ...((rawRow.reason ?? rawRow.error) ? { reason: String(rawRow.reason ?? rawRow.error) } : {}),
    } satisfies KnowledgeImportRow;
  });
  const numberValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const totals = rawPreview.totals && typeof rawPreview.totals === 'object' && !Array.isArray(rawPreview.totals)
    ? rawPreview.totals as Record<string, unknown>
    : {};
  const counts = preview?.counts ?? (() => {
    const ready = numberValue(rawPreview.validRows) ?? numberValue(totals.valid);
    const duplicate = numberValue(rawPreview.duplicateRows) ?? numberValue(totals.duplicate);
    const conflict = numberValue(rawPreview.conflictRows) ?? numberValue(totals.conflict);
    const error = numberValue(rawPreview.invalidRows) ?? numberValue(totals.error);
    if (ready === undefined && duplicate === undefined && conflict === undefined && error === undefined) return undefined;
    return {
      ready: ready ?? 0,
      duplicate: duplicate ?? 0,
      conflict: conflict ?? 0,
      error: error ?? 0,
      total: numberValue(rawPreview.totalRows) ?? numberValue(totals.total) ?? rows.length,
    };
  })();
  const id = String(preview?.id ?? preview?.importId ?? '');
  return { ...preview, id, rows, ...(counts ? { counts } : {}), ...(preview?.importId ? { importId: preview.importId } : {}) };
}

export function normalizeKnowledgeItem(value: unknown): KnowledgeItem {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const activeVersion = record.activeVersion && typeof record.activeVersion === 'object' && !Array.isArray(record.activeVersion)
    ? record.activeVersion as Record<string, unknown>
    : undefined;
  const product = record.product && typeof record.product === 'object' && !Array.isArray(record.product)
    ? record.product as Record<string, unknown>
    : undefined;
  const productId = stringValue(record.productId) ?? stringValue(product?.id) ?? null;
  const activeVersionValue = activeVersion
    ? {
        id: stringValue(activeVersion.id),
        version: typeof activeVersion.version === 'number' || typeof activeVersion.version === 'string' ? activeVersion.version : undefined,
        question: stringValue(activeVersion.question),
        answer: stringValue(activeVersion.answer),
        indexStatus: String(activeVersion.indexStatus ?? 'PENDING') as KnowledgeIndexStatus,
        effectiveFrom: stringValue(activeVersion.effectiveFrom),
        effectiveTo: stringValue(activeVersion.effectiveTo),
      } satisfies KnowledgeVersionSnapshot
    : record.activeVersion as number | string | null | undefined;
  const activeVersionNumber = activeVersion && (typeof activeVersion.version === 'number' || typeof activeVersion.version === 'string')
    ? activeVersion.version
    : typeof record.activeVersion === 'number' || typeof record.activeVersion === 'string' ? record.activeVersion : undefined;
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    productId,
    productTitle: stringValue(record.productTitle) ?? stringValue(product?.title) ?? stringValue(product?.name),
    name: stringValue(record.name),
    question: stringValue(record.question) ?? stringValue(activeVersion?.question) ?? '',
    answer: stringValue(record.answer) ?? stringValue(activeVersion?.answer) ?? '',
    scope: record.scope === 'PRODUCT' || productId ? 'PRODUCT' : 'STORE',
    sourceType: String(record.sourceType ?? 'MANUAL') as KnowledgeSourceType,
    businessStatus: String(record.businessStatus ?? record.status ?? 'DRAFT') as KnowledgeBusinessStatus,
    indexStatus: String(record.indexStatus ?? activeVersion?.indexStatus ?? 'PENDING') as KnowledgeIndexStatus,
    activeVersion: activeVersionValue,
    activeVersionId: stringValue(record.activeVersionId) ?? stringValue(activeVersion?.id),
    version: typeof record.version === 'number' || typeof record.version === 'string' ? record.version : activeVersionNumber,
    sourceVersion: stringValue(record.sourceVersion),
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    updatedAt: stringValue(record.updatedAt),
    createdAt: stringValue(record.createdAt),
  };
}

export function normalizeCustomerDataDeletionResult(value: unknown): CustomerDataDeletionResult {
  const record = objectRecord(value);
  const deleted = objectRecord(record?.deleted);
  const anonymized = objectRecord(record?.anonymized);
  const preserved = objectRecord(record?.preserved);
  const count = (source: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const result: CustomerDataDeletionResult = {
    buyerId: typeof record?.buyerId === 'string' ? record.buyerId : '',
    status: 'COMPLETED',
    deleted: {
      conversations: count(deleted, 'conversations') ?? -1,
      messages: count(deleted, 'messages') ?? -1,
      attachments: count(deleted, 'attachments') ?? -1,
      customerMemories: count(deleted, 'customerMemories') ?? -1,
      knowledgeCandidates: count(deleted, 'knowledgeCandidates') ?? -1,
    },
    anonymized: {
      buyers: count(anonymized, 'buyers') ?? -1,
      orders: count(anonymized, 'orders') ?? -1,
    },
    preserved: {
      anonymousAggregates: count(preserved, 'anonymousAggregates') ?? -1,
      auditFacts: count(preserved, 'auditFacts') ?? -1,
    },
    completedAt: typeof record?.completedAt === 'string' ? record.completedAt : '',
  };
  if (!result.buyerId || !result.completedAt || Object.values(result.deleted).some((item) => item < 0) || Object.values(result.anonymized).some((item) => item < 0) || Object.values(result.preserved).some((item) => item < 0)) {
    throw new ApiError('客户数据删除接口未返回有效结果。', 502, 'CUSTOMER_DATA_DELETION_RESULT_INVALID');
  }
  return result;
}

const syntheticDynamicFactOrderStatuses = new Set<SyntheticDynamicFactOrderStatus>([
  'WAITING_SHIPMENT',
  'SHIPPED',
  'COMPLETED',
]);

export function isSyntheticDynamicFactOrderStatus(value: string): value is SyntheticDynamicFactOrderStatus {
  return syntheticDynamicFactOrderStatuses.has(value as SyntheticDynamicFactOrderStatus);
}

export function normalizeSyntheticDynamicFactAccepted(value: unknown): SyntheticDynamicFactAccepted {
  const record = objectRecord(extractEntity<unknown>(value, 'operation')) ?? {};
  if (record.status !== 'ACCEPTED' || typeof record.operationId !== 'string' || !record.operationId) {
    throw new ApiError('动态事实变更未返回有效的 202 回执。', 502, 'DYNAMIC_FACT_RECEIPT_INVALID');
  }
  return { status: 'ACCEPTED', operationId: record.operationId };
}

export function normalizeKnowledgeCandidate(value: unknown): KnowledgeCandidate {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    productId: stringValue(record.productId) ?? null,
    source: String(record.source ?? 'UNKNOWN'),
    proposedQuestion: String(record.proposedQuestion ?? record.question ?? ''),
    proposedAnswer: String(record.proposedAnswer ?? record.answer ?? ''),
    status: String(record.status ?? 'PENDING') as KnowledgeCandidateStatus,
    duplicateOfId: stringValue(record.duplicateOfId) ?? null,
    conflictWithId: stringValue(record.conflictWithId) ?? null,
    updatedAt: stringValue(record.updatedAt),
  };
}

export function normalizeKnowledgeConflict(value: unknown): KnowledgeConflict {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalizeSide = (name: 'left' | 'right'): KnowledgeConflictSideSnapshot => {
    const side = record[name] && typeof record[name] === 'object' && !Array.isArray(record[name])
      ? record[name] as Record<string, unknown>
      : {};
    return {
      itemId: stringValue(side.itemId) ?? stringValue(record[`${name}ItemId`]),
      versionId: stringValue(side.versionId) ?? stringValue(record[`${name}VersionId`]),
      version: typeof side.version === 'number' || typeof side.version === 'string' ? side.version : undefined,
      question: stringValue(side.question) ?? stringValue(record[`${name}Question`]),
      answer: stringValue(side.answer) ?? stringValue(record[`${name}Answer`]),
      indexStatus: String(side.indexStatus ?? record[`${name}IndexStatus`] ?? '') as KnowledgeIndexStatus,
    };
  };
  const left = normalizeSide('left');
  const right = normalizeSide('right');
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    leftItemId: left.itemId ?? '',
    rightItemId: right.itemId ?? '',
    leftVersionId: left.versionId ?? '',
    rightVersionId: right.versionId ?? '',
    left,
    right,
    status: String(record.status ?? 'OPEN') as KnowledgeConflict['status'],
    resolution: record.resolution,
    resolvedAt: stringValue(record.resolvedAt) ?? null,
    updatedAt: stringValue(record.updatedAt),
  };
}

export function normalizeProductLearningJob(value: unknown): ProductLearningJob {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const totals = record.totals && typeof record.totals === 'object' && !Array.isArray(record.totals)
    ? record.totals as Record<string, unknown>
    : {};
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map((value) => {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      productId: String(item.productId ?? ''),
      status: String(item.status ?? 'PENDING') as ProductLearningStatus,
      reason: typeof item.reason === 'string' ? item.reason : null,
    } satisfies ProductLearningJobItem;
  }).filter((item) => item.productId);
  const numeric = (...values: unknown[]): number | undefined => {
    const value = values.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
    return typeof value === 'number' ? value : undefined;
  };
  const total = numeric(record.total, record.totalProducts, totals.total) ?? items.length;
  const completed = numeric(record.completed, record.completedProducts, totals.completed)
    ?? items.filter((item) => item.status === 'SUCCEEDED').length;
  const processing = numeric(record.processing, record.processingProducts, totals.processing)
    ?? items.filter((item) => item.status === 'PROCESSING' || item.status === 'PENDING').length;
  const failed = numeric(record.failed, record.failedProducts, totals.failed)
    ?? items.filter((item) => item.status === 'FAILED').length;
  const created = numeric(totals.created, record.createdProducts) ?? 0;
  const updated = numeric(totals.updated, record.updatedProducts) ?? 0;
  const skipped = numeric(totals.skipped, record.skippedProducts) ?? Math.max(0, completed - created - updated);
  const progressValue = numeric(record.progress);
  const progress = progressValue === undefined
    ? total > 0 ? Math.round((completed / total) * 100) : 0
    : progressValue <= 1 ? progressValue * 100 : progressValue;
  const operationStatus = String(record.status ?? 'ACCEPTED');
  return {
    id: String(record.id ?? record.operationId ?? ''),
    shopId: stringValue(record.shopId),
    status: operationStatus as ProductLearningJobStatus,
    totals: { total, created, updated, skipped, failed },
    items,
    total,
    completed,
    processing,
    failed,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    startedAt: stringValue(record.startedAt),
    finishedAt: stringValue(record.finishedAt ?? record.completedAt),
    updatedAt: stringValue(record.updatedAt),
  };
}
