import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  approveActionProposal,
  ApiError,
  clearStoredWorkspaceToken,
  createWorkspace,
  editBuyerMessage,
  getBootstrap,
  getBuyers,
  getConversation,
  getConversationTrace,
  getConversations,
  getCustomerMemories,
  getKnowledge,
  getKnowledgeCandidates,
  getKnowledgeConflicts,
  getProductLearningJobs,
  getOrders,
  getProducts,
  isWorkspaceCredentialError,
  messageText,
  recallBuyerMessage,
  regenerateReply,
  resumeConversationAi,
  readStoredWorkspaceToken,
  resetCurrentWorkspace,
  setConversationMode,
  sendBuyerMessage,
  sendBuyerOrderCard,
  sendBuyerProductCard,
  sendConversationMessage,
  storeWorkspaceToken,
  takeoverConversation,
  createCustomerMemory,
  disableCustomerMemory,
  deleteCustomerMemory,
  draftRemainingMs,
  mergeCustomerMemoryMutation,
  updateCustomerMemory,
  commitKnowledgeImport,
  approveKnowledgeCandidate,
  classifyImportRows,
  deleteKnowledge,
  getIncidents,
  getQualityReviews,
  addIncidentRegression,
  concludeQualityReview,
  getScenarios,
  getUsageSummary,
  getWorkflow,
  getWorkflowRuns,
  getWorkflows,
  parseKnowledgeCsv,
  previewKnowledgeImport,
  reindexKnowledge,
  rejectKnowledgeCandidate,
  rejectActionProposal,
  resolveIncident,
  saveIncidentCorrection,
  saveIncidentRootCause,
  disableWorkflow,
  enableWorkflow,
  publishWorkflow,
  saveWorkflowDraft,
  startQualityReview,
  resolveKnowledgeConflict,
  resetScenario,
  runScenario,
  startProductLearning,
  syncProducts,
  type Buyer,
  type Conversation,
  type ExistingKnowledgeMatch,
  type KnowledgeImportPreview,
  type KnowledgeImportRow,
  type KnowledgeCandidate,
  type KnowledgeConflict,
  type KnowledgeConflictResolution,
  type KnowledgeItem,
  type ProductLearningJob,
  type ProductLearningStatus,
  type Message,
  type Order,
  type Product,
  type ReplyDraft,
  type CustomerMemory,
  type CustomerMemoryInputDto,
  type QualityReview,
  type QualityResult,
  type DeveloperTrace,
  type ReplyIncident,
  type Scenario,
  type SendOutbox,
  type ShopSummary,
  type UsageSummary,
  type Workflow,
  type WorkflowGraph,
  type WorkflowRun,
} from '../../api';
import { connectWorkspaceSocket, refreshConversationForWorkspaceEvent, type WorkspaceSocketEvent, type WorkspaceSocketStatus } from '../../workspace-socket';
import { buyerTextSubmissionEnabled, humanFinalSubmission } from '../../workbench-actions';
import { navIcons, navigationItems, resolveAppPath, type AppPath } from '../../app/routes';
import { EmptyState, ErrorState as Phase05ErrorState, LoadingState as Phase05LoadingState } from '../../components/ui/feedback';
import { AdminPageHeader as Phase05AdminHeader, AdminTabs } from '../admin/AdminChrome';
import { DataPrivacyPage } from '../privacy/DataPrivacyPage';
import { UsageAdminPage } from '../usage/UsageAdminPage';
import type {
  Bootstrap as BootstrapPayload,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from '@ai-customer-service/contracts';


export interface FoundationState {
  status: 'loading' | 'ready' | 'error';
  bootstrap?: BootstrapPayload;
  error?: string;
}

export interface SharedViewProps {
  token: string;
  shops: ShopSummary[];
  activeShopId: string;
  onShopChange: (shopId: string) => void;
  refreshKey: number;
  realtimeEvent?: WorkspaceSocketEvent;
  traceOpen?: boolean;
  onTraceClose?: () => void;
  onFoundationRefresh?: () => Promise<void>;
}

export const defaultNavigationItem = navigationItems[0]!;

export function readableTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function readableDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
}

export function shortId(value?: string): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

export function buyerName(buyer?: Buyer): string {
  return buyer?.displayName ?? buyer?.name ?? buyer?.externalBuyerId ?? '未命名买家';
}

export function productName(product?: Product): string {
  return product?.title ?? product?.name ?? product?.externalProductId ?? '未命名商品';
}

export function orderName(order?: Order): string {
  return order?.externalOrderId ?? order?.orderNo ?? order?.id ?? '未命名订单';
}

export function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    CONNECTED: '已连接',
    RECONNECTING: '重连中',
    RECONCILING: '同步中',
    DEGRADED: '降级',
    DISCONNECTED: '离线',
    AUTO: '自动',
    ASSIST: '辅助',
    MANUAL: '人工',
    HOLD: '暂停',
    ACTIVE: '进行中',
    RECALLED: '已撤回',
    EDITED: '已编辑',
    DELETED: '已删除',
    ON_SHELF: '在售',
    OFF_SHELF: '下架',
    COMPLETED: '已完成',
    SHIPPED: '已发货',
    PAID: '已付款',
    PENDING: '待处理',
  };
  return status ? labels[status] ?? status : '—';
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '该资源接口尚未启用，页面保留可用空态。';
    return error.message;
  }
  return '快照读取失败，请稍后重试。';
}

export function modeLabel(mode?: string): string {
  if (mode === 'AUTO_ALLOWED') return '自动接待';
  if (mode === 'ASSIST_ONLY') return '辅助模式';
  if (mode === 'MANUAL_ONLY') return '人工模式';
  return mode ? statusLabel(mode) : '辅助模式';
}

export function connectionStateLabel(state?: string): string {
  const labels: Record<string, string> = {
    CONNECTED: '已连接',
    RECONNECTING: '重连中',
    RECONCILING: '同步中',
    DEGRADED: '降级',
    DISCONNECTED: '离线',
  };
  return state ? labels[state] ?? '未知状态' : '未知状态';
}

export type AdminMetricSnapshot = {
  value: number | null;
  sampleSize: number;
};

export type AdminOverviewSnapshot = {
  onlineShops: AdminMetricSnapshot;
  todayInbound: AdminMetricSnapshot;
  humanTakeover: AdminMetricSnapshot;
  fastPath: AdminMetricSnapshot;
  llmReply: AdminMetricSnapshot;
  aiUsage: AdminMetricSnapshot;
  qualityPassRate: AdminMetricSnapshot;
};

export type ConversationTrendPoint = {
  key: string;
  label: string;
  count: number;
};

export function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function conversationTimestamp(conversation: Conversation): string | undefined {
  return conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
}

export function metric(value: number | null, sampleSize: number): AdminMetricSnapshot {
  return { value, sampleSize };
}

/**
 * Derive the Overview cards from Workspace-scoped snapshots only. A null value
 * means the required source did not return enough evidence; callers must not
 * replace it with a guessed commercial KPI.
 */
export function buildAdminOverviewSnapshot(
  shops: ShopSummary[],
  conversationsByShop: Record<string, Conversation[]>,
  usage?: UsageSummary,
  qualityReviews: QualityReview[] = [],
  now = new Date(),
): AdminOverviewSnapshot {
  const conversations = Object.values(conversationsByShop).flat();
  const todayKey = localDayKey(now);
  const datedConversations = conversations.filter((conversation) => {
    const timestamp = conversationTimestamp(conversation);
    return Boolean(timestamp && !Number.isNaN(new Date(timestamp).getTime()));
  });
  const todayInbound = datedConversations.filter((conversation) => localDayKey(new Date(conversationTimestamp(conversation)!)) === todayKey).length;
  const completedQuality = qualityReviews.filter((review) => {
    const result = review.humanResult ?? (['PASS', 'FAIL'].includes(review.status) ? review.status : undefined);
    return result !== undefined;
  });
  const qualityPasses = completedQuality.filter((review) => (review.humanResult ?? review.status) === 'PASS').length;

  return {
    onlineShops: metric(shops.length ? shops.filter((shop) => shop.connectionState === 'CONNECTED').length : null, shops.length),
    todayInbound: metric(datedConversations.length ? todayInbound : null, conversations.length),
    humanTakeover: metric(conversations.length ? conversations.filter((conversation) => conversation.humanActive === true).length : null, conversations.length),
    fastPath: metric(usage ? usage.fastPathReplies : null, usage ? 1 : 0),
    llmReply: metric(usage?.byPurpose.REPLY_GENERATION?.calls ?? null, usage ? 1 : 0),
    aiUsage: metric(usage ? usage.calls : null, usage ? 1 : 0),
    qualityPassRate: metric(completedQuality.length ? Math.round((qualityPasses / completedQuality.length) * 100) : null, completedQuality.length),
  };
}

/** Build a bounded seven-day conversation trend from returned timestamps. */
export function buildConversationTrend(conversations: Conversation[], now = new Date(), days = 7): ConversationTrendPoint[] {
  const boundedDays = Math.min(30, Math.max(1, Math.trunc(days)));
  const points: ConversationTrendPoint[] = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    const timestamp = conversationTimestamp(conversation);
    if (!timestamp) continue;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) continue;
    const day = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    const age = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    if (age < 0 || age >= boundedDays) continue;
    const key = localDayKey(day);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let age = boundedDays - 1; age >= 0; age -= 1) {
    const day = new Date(today.getTime() - age * 86_400_000);
    points.push({
      key: localDayKey(day),
      label: new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(day),
      count: counts.get(localDayKey(day)) ?? 0,
    });
  }
  return points;
}

export type WorkbenchConversationMode = 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD';

/**
 * A shop policy is a ceiling for the conversation mode selector. The server
 * snapshot remains authoritative for the selected value; this helper only
 * prevents issuing commands that the shop policy cannot accept.
 */
export function isConversationModeAllowed(
  mode: WorkbenchConversationMode,
  shopAiMode?: ShopSummary['aiMode'],
): boolean {
  if (mode === 'AUTO') return shopAiMode === undefined || shopAiMode === 'AUTO_ALLOWED';
  if (mode === 'ASSIST') return shopAiMode !== 'MANUAL_ONLY';
  return true;
}

export function conversationModeOptionLabel(
  mode: WorkbenchConversationMode,
  shopAiMode?: ShopSummary['aiMode'],
): string {
  const labels: Record<WorkbenchConversationMode, string> = {
    AUTO: 'AUTO · 自动',
    ASSIST: 'ASSIST · 辅助',
    MANUAL: 'MANUAL · 人工',
    HOLD: 'HOLD · 暂停',
  };
  if (isConversationModeAllowed(mode, shopAiMode)) return labels[mode];
  return `${labels[mode]}（店铺上限）`;
}

export function replyJobStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    PENDING: '待处理',
    GENERATING: '生成中',
    FAST_PATH_READY: '快速回复就绪',
    WAITING_HUMAN: '等待人工',
    SENT: '已发送',
    CANCELLING: '取消中',
    STALE: '已失效',
    EXPIRED: '已过期',
    CANCELLED: '已取消',
    FAILED: '失败',
    RECOVERY_PENDING: '待恢复',
  };
  return status ? labels[status] ?? status : '暂无任务';
}

export function draftStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    GENERATING: '生成中',
    WAITING_HUMAN: '等待人审',
    STALE: '上下文已变更',
    EXPIRED: '已过期',
    FAILED: '生成失败',
    SENT: '已发送',
    CANCELLED: '已取消',
  };
  return status ? labels[status] ?? status : '暂无 Draft';
}

export function sendOutboxStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    PENDING: '待发送',
    SENDING: '发送中',
    SENT: '发送成功',
    FAILED: '发送失败',
    UNCERTAIN: '结果待确认',
    CANCELLED: '已取消',
  };
  return status ? labels[status] ?? status : '未创建发送任务';
}

export function draftRemainingLabel(remainingMs: number): string {
  if (remainingMs <= 0) return '已过期';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒后失效` : `${seconds}秒后失效`;
}

export function taskStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    OPEN: '待处理',
    RUNNING: '执行中',
    RESOLVED: '已解决',
    AMBIGUOUS: '需澄清',
    FAILED: '失败',
    SUPERSEDED: '已替代',
    CANCELLED: '已取消',
  };
  return status ? labels[status] ?? status : '—';
}

export function tagsFromBuyer(buyer?: Buyer): string[] {
  if (Array.isArray(buyer?.tags)) return buyer.tags;
  if (Array.isArray(buyer?.tagsJson)) return buyer.tagsJson.filter((tag): tag is string => typeof tag === 'string');
  return [];
}

export function firstSku(product?: Product): Product['sku'] {
  return product?.sku ?? product?.skus?.[0];
}

export function productPrice(product?: Product): string {
  const sku = firstSku(product);
  const price = product?.price ?? sku?.price;
  if (price === undefined || price === null || price === '') return '价格待同步';
  return `¥${Number(price).toFixed(2)}`;
}

export function productInventory(product?: Product): string {
  const sku = firstSku(product);
  const inventory = product?.inventory ?? sku?.inventory;
  return inventory === undefined || inventory === null ? '库存待同步' : `${inventory} 件库存`;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export const tracePrivateKeyPattern = /prompt|chain.?of.?thought|\bcot\b|secret|credential|token|private/i;

export function redactTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[redacted]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactTraceValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !tracePrivateKeyPattern.test(key))
      .map(([key, item]) => [key, redactTraceValue(item, depth + 1)]));
  }
  return value;
}

export function redactDeveloperTracePayload(value: unknown): Record<string, unknown> {
  const redacted = redactTraceValue(value);
  return objectValue(redacted) ?? {};
}

export function shouldLoadDeveloperTrace(traceOpen: boolean, conversationId?: string): boolean {
  return traceOpen && Boolean(conversationId);
}

export function traceRequestedBySearch(search: string): boolean {
  return new URLSearchParams(search).get('trace') === '1';
}

export function visibleDeveloperTraceEvents(trace?: DeveloperTrace): Array<{ id: string; stage: string; createdAt: string; payload: Record<string, unknown> }> {
  return trace?.events.map((event) => ({
    id: event.id,
    stage: event.stage,
    createdAt: event.createdAt,
    payload: redactDeveloperTracePayload(event.payload),
  })) ?? [];
}

export function isMessage(value: unknown): value is Message {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
}

export function cardData(message: Message): Record<string, unknown> {
  const content = objectValue(message.contentJson) ?? objectValue(message.content);
  if (!content) return {};
  const nested = objectValue(content.card) ?? objectValue(content.data);
  return nested ?? content;
}

export function messageKindLabel(kind?: string): string {
  if (kind === 'GOODS_CARD' || kind === 'PRODUCT_CARD') return '商品卡';
  if (kind === 'ORDER_CARD') return '订单卡';
  if (kind === 'IMAGE') return '图片';
  return kind === 'SYSTEM' ? '系统提示' : '文字';
}

export function messageRoleLabel(role?: string): string {
  if (role === 'BUYER') return '买家';
  if (role === 'HUMAN') return '人工客服';
  if (role === 'SYSTEM') return '系统';
  return 'AI 助手';
}

export function messageSort(a: Message, b: Message): number {
  if (typeof a.sequence === 'number' && typeof b.sequence === 'number') return a.sequence - b.sequence;
  const aTime = new Date(a.sentAt ?? a.createdAt ?? '').getTime();
  const bTime = new Date(b.sentAt ?? b.createdAt ?? '').getTime();
  return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
}

export function knowledgeScopeLabel(scope?: string): string {
  return scope === 'PRODUCT' ? '商品' : scope === 'STORE' ? '店铺' : '—';
}

export function knowledgeSourceLabel(source?: string): string {
  if (source === 'HUMAN_REVIEWED') return '人工确认';
  if (source === 'AUTO_LEARNED') return '自动学习';
  if (source === 'MANUAL') return '手工维护';
  return source ?? '—';
}

export function knowledgeBusinessLabel(status?: string): string {
  const labels: Record<string, string> = { ENABLED: '已启用', DRAFT: '草稿', DISABLED: '已停用', OUTDATED: '已过期', CONFLICTED: '冲突', DELETED: '已删除' };
  return status ? labels[status] ?? status : '—';
}

export function knowledgeIndexLabel(status?: string): string {
  const labels: Record<string, string> = { READY: 'Ready', INDEXING: '索引中', PENDING: '待索引', FAILED: '失败' };
  return status ? labels[status] ?? status : '—';
}

export function knowledgeVersion(item: KnowledgeItem): string | number {
  if (typeof item.version === 'number' || typeof item.version === 'string') return item.version;
  if (typeof item.activeVersion === 'number' || typeof item.activeVersion === 'string') return item.activeVersion;
  const nested = objectValue(item.activeVersion)?.version;
  return typeof nested === 'number' || typeof nested === 'string' ? nested : 1;
}

export function knowledgeStatusClass(status?: string): string {
  if (status === 'ENABLED' || status === 'READY') return 'is-positive';
  if (status === 'CONFLICTED' || status === 'FAILED' || status === 'DELETED') return 'is-danger';
  if (status === 'INDEXING' || status === 'PENDING' || status === 'DRAFT') return 'is-waiting';
  return 'is-muted';
}

export function learningStatusLabel(status?: string): string {
  const labels: Record<string, string> = { PENDING: '待处理', PROCESSING: '学习中', RUNNING: '学习中', SUCCEEDED: '已完成', PARTIAL_SUCCESS: '部分完成', FAILED: '失败', OUTDATED: '待更新' };
  return status ? labels[status] ?? status : '待学习';
}

export function learningStatusClass(status?: string): string {
  if (status === 'SUCCEEDED') return 'is-positive';
  if (status === 'FAILED') return 'is-danger';
  if (status === 'PROCESSING' || status === 'RUNNING' || status === 'PENDING' || status === 'PARTIAL_SUCCESS') return 'is-waiting';
  return 'is-muted';
}

export function learningProgress(job?: ProductLearningJob, products: Product[] = []): number {
  if (typeof job?.progress === 'number') return Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress));
  if (job?.items?.length) {
    const total = job.total ?? job.items.length;
    const completed = job.items.filter((item) => item.status === 'SUCCEEDED').length;
    return total ? Math.round((completed / total) * 100) : 0;
  }
  if (job?.total) return Math.round(((job.completed ?? 0) / job.total) * 100);
  const learned = products.filter((product) => {
    const value = objectValue(product.learning) ?? objectValue(product.learningSummary);
    return value?.status === 'SUCCEEDED';
  }).length;
  return products.length ? Math.round((learned / products.length) * 100) : 0;
}

export function eventHasWorkspaceShape(event: WorkspaceSocketEvent): boolean {
  const value = event as Record<string, unknown>;
  return typeof value.eventType === 'string' || typeof value.entityType === 'string';
}

export function isPhase03SnapshotEvent(event: WorkspaceSocketEvent): boolean {
  const eventType = (event as Record<string, unknown>).eventType;
  return eventType === 'PRODUCT_UPDATED' || eventType === 'KNOWLEDGE_UPDATED' || eventType === 'USAGE_UPDATED';
}
