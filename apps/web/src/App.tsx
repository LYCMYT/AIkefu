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
} from './api';
import { connectWorkspaceSocket, refreshConversationForWorkspaceEvent, type WorkspaceSocketEvent, type WorkspaceSocketStatus } from './workspace-socket';
import { buyerTextSubmissionEnabled, humanFinalSubmission } from './workbench-actions';
import { navIcons, navigationItems, resolveAppPath, type AppPath } from './app/routes';
import { EmptyState, ErrorState as Phase05ErrorState, LoadingState as Phase05LoadingState } from './components/ui/feedback';
import { AdminPageHeader as Phase05AdminHeader, AdminTabs } from './features/admin/AdminChrome';
import { DataPrivacyPage } from './features/privacy/DataPrivacyPage';
import { UsageAdminPage } from './features/usage/UsageAdminPage';
import type {
  Bootstrap as BootstrapPayload,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from '@ai-customer-service/contracts';

export { navigationItems } from './app/routes';

interface FoundationState {
  status: 'loading' | 'ready' | 'error';
  bootstrap?: BootstrapPayload;
  error?: string;
}

interface SharedViewProps {
  token: string;
  shops: ShopSummary[];
  activeShopId: string;
  onShopChange: (shopId: string) => void;
  refreshKey: number;
  realtimeEvent?: WorkspaceSocketEvent;
  traceOpen?: boolean;
}

const defaultNavigationItem = navigationItems[0]!;

function readableTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function readableDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
}

function shortId(value?: string): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function buyerName(buyer?: Buyer): string {
  return buyer?.displayName ?? buyer?.name ?? buyer?.externalBuyerId ?? '未命名买家';
}

function productName(product?: Product): string {
  return product?.title ?? product?.name ?? product?.externalProductId ?? '未命名商品';
}

function orderName(order?: Order): string {
  return order?.externalOrderId ?? order?.orderNo ?? order?.id ?? '未命名订单';
}

function statusLabel(status?: string): string {
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

function errorMessage(error: unknown): string {
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

function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function conversationTimestamp(conversation: Conversation): string | undefined {
  return conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt;
}

function metric(value: number | null, sampleSize: number): AdminMetricSnapshot {
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
export function buildConversationTrend(conversations: Conversation[], now = new Date()): ConversationTrendPoint[] {
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
    if (age < 0 || age > 6) continue;
    const key = localDayKey(day);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let age = 6; age >= 0; age -= 1) {
    const day = new Date(today.getTime() - age * 86_400_000);
    points.push({
      key: localDayKey(day),
      label: new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(day),
      count: counts.get(localDayKey(day)) ?? 0,
    });
  }
  return points;
}

type WorkbenchConversationMode = 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD';

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

function replyJobStatusLabel(status?: string): string {
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

function draftStatusLabel(status?: string): string {
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

function draftRemainingLabel(remainingMs: number): string {
  if (remainingMs <= 0) return '已过期';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒后失效` : `${seconds}秒后失效`;
}

function taskStatusLabel(status?: string): string {
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

function tagsFromBuyer(buyer?: Buyer): string[] {
  if (Array.isArray(buyer?.tags)) return buyer.tags;
  if (Array.isArray(buyer?.tagsJson)) return buyer.tagsJson.filter((tag): tag is string => typeof tag === 'string');
  return [];
}

function firstSku(product?: Product): Product['sku'] {
  return product?.sku ?? product?.skus?.[0];
}

function productPrice(product?: Product): string {
  const sku = firstSku(product);
  const price = product?.price ?? sku?.price;
  if (price === undefined || price === null || price === '') return '价格待同步';
  return `¥${Number(price).toFixed(2)}`;
}

function productInventory(product?: Product): string {
  const sku = firstSku(product);
  const inventory = product?.inventory ?? sku?.inventory;
  return inventory === undefined || inventory === null ? '库存待同步' : `${inventory} 件库存`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const tracePrivateKeyPattern = /prompt|chain.?of.?thought|\bcot\b|secret|credential|token|private/i;

function redactTraceValue(value: unknown, depth = 0): unknown {
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

function isMessage(value: unknown): value is Message {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
}

function cardData(message: Message): Record<string, unknown> {
  const content = objectValue(message.contentJson) ?? objectValue(message.content);
  if (!content) return {};
  const nested = objectValue(content.card) ?? objectValue(content.data);
  return nested ?? content;
}

function messageKindLabel(kind?: string): string {
  if (kind === 'GOODS_CARD' || kind === 'PRODUCT_CARD') return '商品卡';
  if (kind === 'ORDER_CARD') return '订单卡';
  if (kind === 'IMAGE') return '图片';
  return kind === 'SYSTEM' ? '系统提示' : '文字';
}

function messageRoleLabel(role?: string): string {
  if (role === 'BUYER') return '买家';
  if (role === 'HUMAN') return '人工客服';
  if (role === 'SYSTEM') return '系统';
  return 'AI 助手';
}

function messageSort(a: Message, b: Message): number {
  if (typeof a.sequence === 'number' && typeof b.sequence === 'number') return a.sequence - b.sequence;
  const aTime = new Date(a.sentAt ?? a.createdAt ?? '').getTime();
  const bTime = new Date(b.sentAt ?? b.createdAt ?? '').getTime();
  return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
}

function knowledgeScopeLabel(scope?: string): string {
  return scope === 'PRODUCT' ? '商品' : scope === 'STORE' ? '店铺' : '—';
}

function knowledgeSourceLabel(source?: string): string {
  if (source === 'HUMAN_REVIEWED') return '人工确认';
  if (source === 'AUTO_LEARNED') return '自动学习';
  if (source === 'MANUAL') return '手工维护';
  return source ?? '—';
}

function knowledgeBusinessLabel(status?: string): string {
  const labels: Record<string, string> = { ENABLED: '已启用', DRAFT: '草稿', DISABLED: '已停用', OUTDATED: '已过期', CONFLICTED: '冲突', DELETED: '已删除' };
  return status ? labels[status] ?? status : '—';
}

function knowledgeIndexLabel(status?: string): string {
  const labels: Record<string, string> = { READY: 'Ready', INDEXING: '索引中', PENDING: '待索引', FAILED: '失败' };
  return status ? labels[status] ?? status : '—';
}

function knowledgeVersion(item: KnowledgeItem): string | number {
  if (typeof item.version === 'number' || typeof item.version === 'string') return item.version;
  if (typeof item.activeVersion === 'number' || typeof item.activeVersion === 'string') return item.activeVersion;
  const nested = objectValue(item.activeVersion)?.version;
  return typeof nested === 'number' || typeof nested === 'string' ? nested : 1;
}

function knowledgeStatusClass(status?: string): string {
  if (status === 'ENABLED' || status === 'READY') return 'is-positive';
  if (status === 'CONFLICTED' || status === 'FAILED' || status === 'DELETED') return 'is-danger';
  if (status === 'INDEXING' || status === 'PENDING' || status === 'DRAFT') return 'is-waiting';
  return 'is-muted';
}

function learningStatusLabel(status?: string): string {
  const labels: Record<string, string> = { PENDING: '待处理', PROCESSING: '学习中', RUNNING: '学习中', SUCCEEDED: '已完成', PARTIAL_SUCCESS: '部分完成', FAILED: '失败', OUTDATED: '待更新' };
  return status ? labels[status] ?? status : '待学习';
}

function learningStatusClass(status?: string): string {
  if (status === 'SUCCEEDED') return 'is-positive';
  if (status === 'FAILED') return 'is-danger';
  if (status === 'PROCESSING' || status === 'RUNNING' || status === 'PENDING' || status === 'PARTIAL_SUCCESS') return 'is-waiting';
  return 'is-muted';
}

function learningProgress(job?: ProductLearningJob, products: Product[] = []): number {
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

function eventHasWorkspaceShape(event: WorkspaceSocketEvent): boolean {
  const value = event as Record<string, unknown>;
  return typeof value.eventType === 'string' || typeof value.entityType === 'string';
}

function isPhase03SnapshotEvent(event: WorkspaceSocketEvent): boolean {
  const eventType = (event as Record<string, unknown>).eventType;
  return eventType === 'PRODUCT_UPDATED' || eventType === 'KNOWLEDGE_UPDATED' || eventType === 'USAGE_UPDATED';
}

function Avatar({ label, tone = 'mint' }: { label?: string; tone?: 'mint' | 'orange' | 'blue' | 'dark' }) {
  return <span className={`avatar avatar-${tone}`} aria-hidden="true">{(label ?? 'R').slice(0, 1)}</span>;
}

function MessageBubble({ message, dense = false }: { message: Message; dense?: boolean }) {
  const role = message.role ?? 'ASSISTANT';
  const isBuyer = role === 'BUYER';
  const isSystem = role === 'SYSTEM';
  const isProductCard = message.kind === 'GOODS_CARD' || message.kind === 'PRODUCT_CARD';
  const card = cardData(message);
  const cardProduct = message.product ?? (objectValue(card.product) as Product | undefined) ?? (isProductCard ? {
    id: String(card.productId ?? card.externalProductId ?? `card-${message.id}`),
    title: typeof card.title === 'string' ? card.title : undefined,
    externalProductId: typeof card.externalProductId === 'string' ? card.externalProductId : undefined,
  } : undefined);
  const cardOrder = message.order ?? (objectValue(card.order) as Order | undefined) ?? (message.kind === 'ORDER_CARD' ? {
    id: String(card.orderId ?? card.externalOrderId ?? `card-${message.id}`),
    externalOrderId: typeof card.externalOrderId === 'string' ? card.externalOrderId : undefined,
    status: typeof card.status === 'string' ? card.status : undefined,
  } : undefined);
  const text = messageText(message);
  const recalled = message.status === 'RECALLED' || message.status === 'DELETED';

  return (
    <div className={`message-row ${isBuyer ? 'is-buyer' : ''} ${isSystem ? 'is-system' : ''} ${dense ? 'is-dense' : ''}`}>
      {!isBuyer && !isSystem && <Avatar label={role === 'HUMAN' ? '人' : 'AI'} tone={role === 'HUMAN' ? 'orange' : 'blue'} />}
      <div className="message-stack">
        <div className="message-meta">
          <span>{messageRoleLabel(role)}</span>
          <span>{readableTime(message.sentAt ?? message.createdAt)}</span>
          <span className="message-kind">{messageKindLabel(message.kind)}</span>
          {message.status === 'EDITED' && <span className="message-status">已编辑</span>}
        </div>
        {recalled ? (
          <div className="message-bubble is-recalled">这条消息已撤回</div>
        ) : isProductCard ? (
          <div className="message-bubble card-bubble product-message-card">
            <div className="card-art product-art" aria-hidden="true">✦</div>
            <div>
              <strong>{productName(cardProduct)}</strong>
              <span>{productPrice(cardProduct)} · {productInventory(cardProduct)}</span>
              <small>{cardProduct?.description ?? '商品详情已由店铺快照提供'}</small>
            </div>
          </div>
        ) : message.kind === 'ORDER_CARD' ? (
          <div className="message-bubble card-bubble order-message-card">
            <div className="card-art order-art" aria-hidden="true">#</div>
            <div>
              <strong>{orderName(cardOrder)}</strong>
              <span>{statusLabel(cardOrder?.status)} · {cardOrder?.amount ? `¥${Number(cardOrder.amount).toFixed(2)}` : '金额待同步'}</span>
              <small>{cardOrder?.product ? productName(cardOrder.product) : '订单上下文已附加'}</small>
            </div>
          </div>
        ) : message.kind === 'IMAGE' ? (
          <div className="message-bubble image-placeholder"><span>▧</span> 图片消息</div>
        ) : (
          <div className="message-bubble">{text || '（空消息）'}</div>
        )}
      </div>
      {isBuyer && <Avatar label="买" tone="mint" />}
    </div>
  );
}

function ShopRail({ shops, activeShopId, onShopChange }: Pick<SharedViewProps, 'shops' | 'activeShopId' | 'onShopChange'>) {
  return (
    <aside className="shop-rail" aria-label="店铺与渠道">
      <div className="rail-heading">
        <div>
          <span className="overline">CHANNELS</span>
          <h2>店铺</h2>
        </div>
        <span className="count-pill">{shops.length}</span>
      </div>
      <div className="shop-rail-list">
        {shops.map((shop) => (
          <button
            className={`shop-tile ${shop.id === activeShopId ? 'is-selected' : ''}`}
            type="button"
            key={shop.id}
            onClick={() => onShopChange(shop.id)}
          >
            <span className={`shop-status-dot is-${shop.connectionState.toLowerCase()}`} />
            <span className="shop-tile-copy">
              <strong>{shop.name}</strong>
              <small>{modeLabel(shop.aiMode)}</small>
            </span>
            <span className="shop-chevron">›</span>
          </button>
        ))}
      </div>
      <div className="channel-disabled">
        <span className="channel-icon">＋</span>
        <div><strong>连接新渠道</strong><small>其他平台 · 规划中</small></div>
      </div>
      <div className="rail-bottom-card">
        <span className="overline">TODAY</span>
        <strong>接待状态良好</strong>
        <div className="health-bar"><span /></div>
        <small>MockDouyin · 数据为当前 Workspace</small>
      </div>
    </aside>
  );
}

function ContextProduct({ product }: { product?: Product }) {
  if (!product) {
    return <EmptyState title="尚未绑定商品" detail="在对话中发送商品卡，或等待 Context Resolver 识别商品。" />;
  }
  return (
    <article className="context-object-card">
      <div className="context-product-art" aria-hidden="true">✦</div>
      <div className="context-object-heading">
        <strong>{productName(product)}</strong>
        <span className={`status-badge ${product.status === 'ON_SHELF' ? 'is-positive' : 'is-muted'}`}>{statusLabel(product.status)}</span>
      </div>
      <p>{product.description ?? '暂无商品描述。'}</p>
      <dl className="fact-grid">
        <div><dt>价格</dt><dd>{productPrice(product)}</dd></div>
        <div><dt>库存</dt><dd>{productInventory(product)}</dd></div>
        <div><dt>SKU</dt><dd>{firstSku(product)?.externalSkuId ?? '—'}</dd></div>
        <div><dt>推荐</dt><dd>{product.recommendable === false ? '已关闭' : '可推荐'}</dd></div>
      </dl>
    </article>
  );
}

function ContextOrder({ order }: { order?: Order }) {
  if (!order) {
    return <EmptyState title="尚未绑定订单" detail="识别到订单卡后，订单状态与物流快照会显示在这里。" />;
  }
  return (
    <article className="context-object-card order-context-card">
      <div className="order-context-top"><span className="order-icon">#</span><div><strong>{orderName(order)}</strong><small>{readableDate(order.orderedAt)} 创建</small></div><span className="status-badge is-positive">{statusLabel(order.status)}</span></div>
      <div className="order-context-product"><span className="mini-art">✦</span><div><strong>{productName(order.product)}</strong><small>{order.sku?.externalSkuId ?? 'SKU 待同步'}</small></div></div>
      <dl className="fact-grid"><div><dt>实付金额</dt><dd>{order.amount === undefined ? '待同步' : `¥${Number(order.amount).toFixed(2)}`}</dd></div><div><dt>发货时间</dt><dd>{readableDate(order.shippedAt)}</dd></div></dl>
      <div className="logistics-snapshot"><span className="route-line" /><div><small>物流快照</small><strong>{order.logistics ? '已获取静态物流' : '暂无物流节点'}</strong></div></div>
    </article>
  );
}

function DeveloperTracePanel({ open, loading, error, trace, conversationId }: { open: boolean; loading: boolean; error?: string; trace?: DeveloperTrace; conversationId?: string }) {
  if (!open) return null;
  const events = visibleDeveloperTraceEvents(trace);
  return <section className="workbench-trace-panel panel-surface" aria-label="Developer Trace"><div className="trace-panel-heading"><div><span className="overline">DEVELOPER TRACE</span><h3>结构化诊断</h3></div><small>{trace?.traceId ? `Trace · ${trace.traceId}` : conversationId ? `Conversation · ${shortId(conversationId)}` : '未选择会话'}</small></div>{loading ? <Phase05LoadingState label="正在读取 Developer Trace…" /> : error ? <Phase05ErrorState message={error} /> : !trace ? <EmptyState title="暂无 Trace 快照" detail="选择会话后开启 Trace，服务端会返回结构化、已脱敏的事件。" /> : events.length === 0 ? <EmptyState title="暂无 Trace 事件" detail="当前会话尚未产生可展示的结构化诊断事件。" /> : <div className="trace-event-list">{events.map((event) => <article className="trace-event-row" key={event.id}><div><strong>{event.stage}</strong><small>{event.createdAt}</small></div><code>{JSON.stringify(event.payload, null, 2)}</code></article>)}</div>}<small className="trace-panel-note">仅显示结构化脱敏状态；不展示 prompt、模型私有推理或 Chain-of-Thought。</small></section>;
}

function Workbench({ token, shops, activeShopId, onShopChange, refreshKey, realtimeEvent, traceOpen = false }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<Conversation>();
  const [detail, setDetail] = useState<Conversation>();
  const [query, setQuery] = useState('');
  const [contextTab, setContextTab] = useState<'assistant' | 'product' | 'order' | 'memory'>('assistant');
  const [composer, setComposer] = useState('');
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [sendError, setSendError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftEditType, setDraftEditType] = useState<NonNullable<ReplyDraft['editType']>>('STYLE_EDIT');
  const [draftNow, setDraftNow] = useState(() => Date.now());
  const [draftAction, setDraftAction] = useState('');
  const [conversationAction, setConversationAction] = useState('');
  const [memoryAction, setMemoryAction] = useState('');
  const [memories, setMemories] = useState<CustomerMemory[]>([]);
  const [memoryForm, setMemoryForm] = useState<{ type: CustomerMemoryInputDto['type']; key: string; value: string }>({ type: 'PREFERENCE', key: '', value: '' });
  const [editingMemoryId, setEditingMemoryId] = useState('');
  const [developerTrace, setDeveloperTrace] = useState<DeveloperTrace>();
  const [developerTraceLoading, setDeveloperTraceLoading] = useState(false);
  const [developerTraceError, setDeveloperTraceError] = useState('');

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);

  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);

  useEffect(() => {
    if (!shopId) return;
    let mounted = true;
    setLoading(true);
    setResourceError('');
    setConversations([]);
    setProducts([]);
    setOrders([]);
    setMemories([]);
    setDraft(null);
    setDraftText('');
    setDraftEditType('STYLE_EDIT');
    Promise.all([getConversations(token, shopId), getProducts(token, shopId)])
      .then(([nextConversations, nextProducts]) => {
        if (!mounted) return;
        setConversations(nextConversations);
        setProducts(nextProducts);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setResourceError(errorMessage(error));
        setConversations([]);
        setProducts([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [refreshKey, shopId, token]);

  useEffect(() => {
    const visible = conversations.filter((conversation) => {
      const text = messageText(conversation.lastMessage);
      const name = buyerName(conversation.buyer);
      return `${name} ${text} ${conversation.externalConversationId ?? ''}`.toLowerCase().includes(query.toLowerCase());
    });
    if (!selectedConversationId || !visible.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(visible[0]?.id ?? '');
    }
  }, [conversations, query, selectedConversationId]);

  useEffect(() => {
    setSelectedConversation(conversations.find((conversation) => conversation.id === selectedConversationId));
  }, [conversations, selectedConversationId]);

  useEffect(() => {
    const listed = conversations.find((conversation) => conversation.id === selectedConversationId);
    setDetail(undefined);
    setLocalMessages([]);
    setDraft(null);
    setDraftText('');
    setDraftEditType('STYLE_EDIT');
    setMemories([]);
    if (!selectedConversationId) {
      setOrders([]);
      return;
    }
    let mounted = true;
    void getConversation(token, selectedConversationId)
      .then((conversation) => {
        if (mounted) setDetail(conversation);
      })
      .catch(() => {
        // A list snapshot is still useful while the detail endpoint is rolling out.
      });
    if (listed?.buyerId) {
      void getOrders(token, shopId, listed.buyerId).then((nextOrders) => {
        if (mounted) setOrders(nextOrders);
      }).catch(() => {
        if (mounted) setOrders([]);
      });
      void getCustomerMemories(token, listed.buyerId, shopId).then((nextMemories) => {
        if (mounted) setMemories(nextMemories);
      }).catch(() => {
        if (mounted) setMemories([]);
      });
    }
    return () => {
      mounted = false;
    };
  }, [selectedConversationId, shopId, token]);

  useEffect(() => {
    if (!shouldLoadDeveloperTrace(traceOpen, selectedConversationId)) {
      setDeveloperTrace(undefined);
      setDeveloperTraceError('');
      setDeveloperTraceLoading(false);
      return;
    }
    let mounted = true;
    setDeveloperTraceLoading(true);
    setDeveloperTraceError('');
    void getConversationTrace(token, selectedConversationId)
      .then((next) => {
        if (mounted) setDeveloperTrace(next);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setDeveloperTrace(undefined);
        setDeveloperTraceError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setDeveloperTraceLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [refreshKey, selectedConversationId, token, traceOpen]);

  const activeShop = shops.find((shop) => shop.id === shopId);
  const visibleConversations = useMemo(() => conversations.filter((conversation) => {
    const text = messageText(conversation.lastMessage);
    return `${buyerName(conversation.buyer)} ${text}`.toLowerCase().includes(query.toLowerCase());
  }), [conversations, query]);
  const activeConversation = detail ?? selectedConversation;
  const activeBuyer = activeConversation?.buyer;
  const activeProduct = activeConversation?.currentProduct ?? products.find((product) => product.id === activeConversation?.currentProductId);
  const activeOrder = activeConversation?.currentOrder ?? orders.find((order) => order.id === activeConversation?.currentOrderId);
  const snapshotDraft = activeConversation?.currentDraft ?? activeConversation?.activeReplyJob?.currentDraft ?? activeConversation?.activeReplyJob?.draft ?? null;

  const applyConversationSnapshot = useCallback((next: Conversation) => {
    setDetail((current) => current?.id === next.id ? { ...current, ...next } : next);
    setSelectedConversation((current) => current?.id === next.id ? { ...current, ...next } : next);
    setConversations((current) => current.map((item) => item.id === next.id ? { ...item, ...next } : item));
  }, []);

  const refreshConversationSnapshot = useCallback(async (conversationId = selectedConversationId): Promise<Conversation | undefined> => {
    if (!conversationId) return undefined;
    const next = await getConversation(token, conversationId);
    applyConversationSnapshot(next);
    return next;
  }, [applyConversationSnapshot, selectedConversationId, token]);

  useEffect(() => {
    setDraft(snapshotDraft);
    setDraftText(snapshotDraft?.humanFinal ?? snapshotDraft?.aiDraft ?? '');
    setDraftEditType(snapshotDraft?.editType ?? 'STYLE_EDIT');
  }, [snapshotDraft?.id, snapshotDraft?.status, snapshotDraft?.aiDraft, snapshotDraft?.humanFinal, snapshotDraft?.expiresAt]);

  useEffect(() => {
    if (!draft || (draft.status !== 'GENERATING' && draft.status !== 'WAITING_HUMAN')) return;
    setDraftNow(Date.now());
    const timer = window.setInterval(() => setDraftNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [draft?.id, draft?.status, draft?.expiresAt]);

  useEffect(() => {
    if (!realtimeEvent) return;
    const event = realtimeEvent as Record<string, unknown>;
    if (event.eventType !== 'REPLY_JOB_STREAM') return;
    const payload = objectValue(event.payload);
    if (!payload || (typeof payload.conversationId === 'string' && payload.conversationId !== selectedConversationId)) return;
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
    if (!chunk || !draft) return;
    const replyJobId = typeof payload.replyJobId === 'string' ? payload.replyJobId : undefined;
    if (replyJobId && draft.replyJobId && replyJobId !== draft.replyJobId) return;
    const nextText = `${draft.aiDraft}${chunk}`;
    const nextDraft = { ...draft, aiDraft: nextText, status: 'GENERATING' as const, humanFinal: null };
    setDraft(nextDraft);
    setDetail((current) => current?.id === selectedConversationId ? { ...current, currentDraft: nextDraft } : current);
    setSelectedConversation((current) => current?.id === selectedConversationId ? { ...current, currentDraft: nextDraft } : current);
    setConversations((current) => current.map((item) => item.id === selectedConversationId ? { ...item, currentDraft: nextDraft } : item));
    if (draftText === draft.aiDraft || draftText === draft.humanFinal) setDraftText(nextText);
  }, [realtimeEvent?.eventId, selectedConversationId]);

  useEffect(() => {
    if (!realtimeEvent || !selectedConversationId) return;
    let mounted = true;
    void refreshConversationForWorkspaceEvent(realtimeEvent, selectedConversationId, refreshConversationSnapshot).catch((error: unknown) => {
      if (mounted) setSendError(`实时事件已收到，但会话快照刷新失败：${errorMessage(error)}`);
    });
    return () => {
      mounted = false;
    };
  }, [realtimeEvent?.eventId, refreshConversationSnapshot, selectedConversationId]);

  const draftRemaining = draft ? draftRemainingMs(draft, draftNow) : 0;
  const draftCanEdit = draft?.status === 'GENERATING' || draft?.status === 'WAITING_HUMAN';
  const effectiveMode = activeConversation?.effectiveMode ?? activeConversation?.overrideMode ?? activeConversation?.mode ?? 'ASSIST';
  const taskBundle = activeConversation?.taskBundle;
  const sendOutbox = activeConversation?.sendOutbox ?? activeConversation?.activeReplyJob?.sendOutbox;
  const messages = useMemo(() => {
    const fromSnapshot = detail?.messages ?? selectedConversation?.messages ?? [];
    const map = new Map<string, Message>();
    [...fromSnapshot, ...localMessages].forEach((message) => map.set(message.id, message));
    return Array.from(map.values()).sort(messageSort);
  }, [detail?.messages, localMessages, selectedConversation?.messages]);

  const changeConversationMode = async (mode: WorkbenchConversationMode) => {
    if (!selectedConversationId) return;
    if (!isConversationModeAllowed(mode, activeShop?.aiMode)) {
      setSendError(`${conversationModeOptionLabel(mode, activeShop?.aiMode)}，无法提交该模式。`);
      return;
    }
    setConversationAction(`mode-${mode}`);
    setSendError('');
    try {
      await setConversationMode(token, selectedConversationId, shopId, mode);
      await refreshConversationSnapshot();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setConversationAction('');
    }
  };

  const takeover = async () => {
    if (!selectedConversationId) return;
    setConversationAction('takeover');
    setSendError('');
    try {
      await takeoverConversation(token, selectedConversationId, shopId);
      await refreshConversationSnapshot();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setConversationAction('');
    }
  };

  const resumeAi = async () => {
    if (!selectedConversationId) return;
    setConversationAction('resume');
    setSendError('');
    try {
      await resumeConversationAi(token, selectedConversationId, shopId);
      await refreshConversationSnapshot();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setConversationAction('');
    }
  };

  const regenerate = async () => {
    if (!selectedConversationId) return;
    setDraftAction('regenerate');
    setSendError('');
    try {
      await regenerateReply(token, selectedConversationId, shopId);
      await refreshConversationSnapshot();
      setSendError('已请求重新生成，等待 ReplyJob 快照。');
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setDraftAction('');
    }
  };

  const sendHumanMessage = async (overrideText?: string, sourceDraftId?: string) => {
    const text = (overrideText ?? composer).trim();
    if (!text || !selectedConversationId) return;
    const durableDraftId = sourceDraftId ?? (draft?.id && draftCanEdit ? draft.id : undefined);
    const submission = humanFinalSubmission({
      humanActive: Boolean(activeConversation?.humanActive),
      sourceDraftId: durableDraftId,
    });
    if (!submission.allowed) {
      setSendError('当前没有可用的 ASSIST Draft；请等待 Draft 生成或先请求重新生成。');
      return;
    }
    setIsSending(true);
    setSendError('');
    try {
      const receipt = await sendConversationMessage(token, selectedConversationId, shopId, {
        text,
        ...(submission.sourceDraftId ? { sourceDraftId: submission.sourceDraftId, editType: draftEditType } : {}),
      });
      setSendError(`Human Final 已接受（${receipt.sendOutboxId}），等待发送回执。`);
      setComposer('');
      await refreshConversationSnapshot();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setIsSending(false);
    }
  };

  const applyDraftToComposer = () => {
    if (!draftText.trim()) return;
    setComposer(draftText.trim());
  };

  const sendDraft = async () => {
    if (!draft?.id || !draftText.trim()) return;
    await sendHumanMessage(draftText, draft.id);
  };

  const saveMemory = async () => {
    if (!activeBuyer?.id || !memoryForm.key.trim() || !memoryForm.value.trim()) return;
    const input: CustomerMemoryInputDto = {
      shopId,
      type: memoryForm.type,
      key: memoryForm.key.trim(),
      value: { text: memoryForm.value.trim() },
    };
    setMemoryAction(editingMemoryId ? `edit-${editingMemoryId}` : 'create');
    setSendError('');
    try {
      const next = editingMemoryId
        ? await updateCustomerMemory(token, editingMemoryId, input)
        : await createCustomerMemory(token, activeBuyer.id, input);
      setMemories((current) => editingMemoryId ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]);
      setEditingMemoryId('');
      setMemoryForm({ type: 'PREFERENCE', key: '', value: '' });
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setMemoryAction('');
    }
  };

  const disableMemory = async (memory: CustomerMemory) => {
    setMemoryAction(`disable-${memory.id}`);
    try {
      const next = await disableCustomerMemory(token, memory.id, shopId);
      setMemories((current) => current.map((item) => item.id === memory.id ? mergeCustomerMemoryMutation(item, next) : item));
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setMemoryAction('');
    }
  };

  const removeMemory = async (memory: CustomerMemory) => {
    setMemoryAction(`delete-${memory.id}`);
    try {
      await deleteCustomerMemory(token, memory.id, shopId);
      setMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setMemoryAction('');
    }
  };

  const contextProductList = activeProduct ? [activeProduct, ...products.filter((product) => product.id !== activeProduct.id).slice(0, 2)] : products.slice(0, 3);

  return (
    <div className="workbench-layout">
      <ShopRail shops={shops} activeShopId={shopId} onShopChange={setShopId} />

      <section className="conversation-panel panel-surface" aria-label="会话列表">
        <div className="conversation-heading">
          <div><span className="overline">INBOX</span><h2>会话</h2></div>
          <span className="count-pill dark-pill">{visibleConversations.length}</span>
        </div>
        <div className="inbox-summary"><span><i className="summary-dot is-waiting" />待处理</span><strong>{visibleConversations.filter((item) => (item.unreadCount ?? 0) > 0).length}</strong><span className="summary-divider" /><span><i className="summary-dot is-ai" />AI 辅助</span></div>
        <label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索买家、订单或消息" /><kbd>/</kbd></label>
        <div className="conversation-tabs"><button className="is-active" type="button">全部</button><button type="button">未读</button><button type="button">已接管</button></div>
        <div className="conversation-list">
          {loading ? <div className="list-loading">正在读取会话快照…</div> : visibleConversations.length === 0 ? <EmptyState title="还没有会话" detail={resourceError || '买家发来消息后，会话会出现在这里。'} /> : visibleConversations.map((conversation) => (
            <button className={`conversation-row ${conversation.id === selectedConversationId ? 'is-selected' : ''}`} type="button" key={conversation.id} onClick={() => setSelectedConversationId(conversation.id)}>
              <Avatar label={buyerName(conversation.buyer)} tone={conversation.mode === 'MANUAL' ? 'orange' : 'mint'} />
              <span className="conversation-row-main"><strong>{buyerName(conversation.buyer)}</strong><small>{messageText(conversation.lastMessage) || '等待第一条消息'}</small><span className="conversation-row-tags"><em>{statusLabel(conversation.overrideMode ?? conversation.effectiveMode ?? conversation.mode ?? 'ASSIST')}</em>{conversation.currentDraft && <em className="draft-tag">Draft · {draftStatusLabel(conversation.currentDraft.status)}</em>}{conversation.syncState === 'DEGRADED' && <em className="risk-tag">DEGRADED</em>}{conversation.needsReplan && <em className="risk-tag">待重规划</em>}</span></span>
              <span className="conversation-row-side"><small>{readableTime(conversation.lastMessageAt ?? conversation.updatedAt)}</small>{(conversation.unreadCount ?? 0) > 0 && <b>{conversation.unreadCount}</b>}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="chat-panel panel-surface" aria-label="聊天与消息">
        {!activeConversation ? <EmptyState title="选择一个会话开始" detail="从左侧收件箱选择买家，消息与 AI 状态会在此展示。" /> : <>
          <header className="chat-heading">
            <div className="chat-person"><Avatar label={buyerName(activeBuyer)} tone="mint" /><div><h2>{buyerName(activeBuyer)}</h2><p><span className="online-mark" />来自 {activeShop?.name ?? '当前店铺'} · {activeConversation.externalConversationId ?? shortId(activeConversation.id)}</p></div></div>
            <div className="chat-heading-actions"><span className={`mode-chip mode-${String(effectiveMode).toLowerCase()}`}>{statusLabel(effectiveMode)}</span><label className="mode-select"><span className="sr-only">会话模式</span><select value={effectiveMode} onChange={(event) => void changeConversationMode(event.currentTarget.value as WorkbenchConversationMode)} disabled={conversationAction !== ''}>{(['AUTO', 'ASSIST', 'MANUAL', 'HOLD'] as const).map((mode) => <option value={mode} key={mode} disabled={!isConversationModeAllowed(mode, activeShop?.aiMode)}>{conversationModeOptionLabel(mode, activeShop?.aiMode)}</option>)}</select></label><button type="button" className="icon-button" title="更多会话操作">•••</button></div>
          </header>
           <div className="conversation-context-strip"><span className="context-lock">⌁</span><span>Context v{activeConversation.contextVersion ?? 1}</span><span className="strip-divider" /><span>{activeConversation.humanActive ? '人工接管中' : effectiveMode === 'MANUAL' ? 'MANUAL · 等待人工' : 'AI 可继续辅助'}</span>{activeConversation.syncState === 'DEGRADED' && <span className="risk-tag">DEGRADED · 禁止自动</span>}{activeConversation.needsReplan && <span className="risk-tag">消息变化，待重规划</span>}{activeConversation.activeReplyJob && <span className="job-inline-status">ReplyJob · {replyJobStatusLabel(activeConversation.activeReplyJob.status)}</span>}</div>
           <div className="conversation-control-bar"><div className="control-summary"><span className={`control-dot ${activeConversation.humanActive || effectiveMode === 'MANUAL' ? 'is-human' : 'is-ai'}`} /><span>{activeConversation.humanActive ? '人工正在处理当前会话' : effectiveMode === 'MANUAL' ? 'MANUAL_ONLY · 需人工回复' : `当前策略 · ${statusLabel(effectiveMode)}`}</span></div><div className="control-actions">{activeConversation.humanActive ? <button type="button" className="outline-button compact-button" onClick={() => void resumeAi()} disabled={conversationAction !== ''}>{conversationAction === 'resume' ? '恢复中…' : '恢复 AI'}</button> : <button type="button" className="outline-button compact-button" onClick={() => void takeover()} disabled={conversationAction !== '' || activeConversation.state === 'CLOSED'}>{conversationAction === 'takeover' ? '接管中…' : '人工接管'}</button>}{effectiveMode !== 'ASSIST' && <button type="button" className="text-button" onClick={() => void changeConversationMode('ASSIST')} disabled={conversationAction !== ''}>设为 ASSIST</button>}</div></div>
          <div className="chat-stream">
            {messages.length === 0 ? <EmptyState title="等待消息" detail="Buyer Simulator 发来文本、商品卡或订单卡后会实时出现在这里。" /> : messages.map((message) => <MessageBubble message={message} key={message.id} />)}
          </div>
          <section className={`draft-card ${draft?.status ? `draft-${draft.status.toLowerCase()}` : 'draft-empty'}`} aria-label="AI Draft 与 Human Final"><div className="draft-card-heading"><div className="draft-icon">✦</div><div><strong>ASSIST Draft</strong><span>{draft ? draftStatusLabel(draft.status) : activeConversation.humanActive ? '人工接管中，Draft 暂停' : '等待 ReplyJob 生成'}</span></div><span className={`draft-state ${draft?.status === 'STALE' || draft?.status === 'EXPIRED' ? 'is-danger' : ''}`}>{draft?.status ?? 'NONE'}</span>{draft?.expiresAt && draftCanEdit && <span className="draft-ttl">{draftRemainingLabel(draftRemaining)}</span>}</div>{draft ? <><textarea className="draft-editor" value={draftText} onChange={(event) => setDraftText(event.currentTarget.value)} disabled={!draftCanEdit} aria-label="Human Final 编辑区" rows={2} /><div className="draft-card-footer"><span>{draft.editType ? `差异 · ${draft.editType}` : draftCanEdit ? 'AI Draft 可编辑，发送前会再次校验 Context' : draft.staleReason ?? 'Draft 不可发送'}</span><div className="draft-actions"><label className="draft-edit-type"><span>编辑类型</span><select value={draftEditType} onChange={(event) => setDraftEditType(event.currentTarget.value as NonNullable<ReplyDraft['editType']>)} disabled={!draftCanEdit} aria-label="Human Final 编辑类型"><option value="STYLE_EDIT">风格调整</option><option value="FACTUAL_CORRECTION">事实修正</option><option value="KNOWLEDGE_ENRICHMENT">知识补充</option></select></label><button type="button" className="text-button" onClick={applyDraftToComposer} disabled={!draftText.trim() || !draftCanEdit}>应用到回复</button>{draftCanEdit && <button type="button" className="outline-button compact-button" onClick={() => void sendDraft()} disabled={!draftText.trim() || isSending || activeConversation.humanActive}>{isSending ? '发送中…' : '发送 Human Final'}</button>}{(draft.status === 'STALE' || draft.status === 'EXPIRED' || draft.status === 'FAILED') && <button type="button" className="text-button" onClick={() => void regenerate()} disabled={draftAction !== '' || activeConversation.humanActive}>{draftAction === 'regenerate' ? '请求中…' : '重新生成'}</button>}</div></div></> : <div className="draft-empty-copy">新的买家消息进入 ReplyJob 后，ASSIST Draft 会显示在这里。</div>}</section>
          {sendError && <p className="inline-error">{sendError}</p>}
          <div className="chat-composer"><button type="button" className="composer-tool" disabled title="暂不支持图片消息">＋</button><textarea value={composer} onChange={(event) => setComposer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendHumanMessage(); } }} placeholder="以客服身份回复…" rows={2} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" type="button" onClick={() => void sendHumanMessage()} disabled={!composer.trim() || !selectedConversationId || isSending}>{isSending ? '发送中…' : '发送回复'}</button></div></div>
        </>}
      </section>

      <aside className="context-panel panel-surface" aria-label="业务上下文">
        <div className="context-heading"><div><span className="overline">CONTEXT</span><h2>业务上下文</h2></div><button type="button" className="icon-button" title="刷新上下文">↻</button></div>
        <div className="context-tabs"><button type="button" className={contextTab === 'assistant' ? 'is-active' : ''} onClick={() => setContextTab('assistant')}>助手</button><button type="button" className={contextTab === 'product' ? 'is-active' : ''} onClick={() => setContextTab('product')}>商品</button><button type="button" className={contextTab === 'order' ? 'is-active' : ''} onClick={() => setContextTab('order')}>订单</button><button type="button" className={contextTab === 'memory' ? 'is-active' : ''} onClick={() => setContextTab('memory')}>记忆</button></div>
        {contextTab === 'assistant' ? <div className="assistant-context"><div className="assistant-status-card"><span className="assistant-orb">✦</span><div><strong>{activeConversation?.humanActive ? '人工接管已开启' : 'AI 辅助准备就绪'}</strong><p>{activeShop ? `${activeShop.name} · ${modeLabel(activeShop.aiMode)}` : '选择店铺后加载策略'}</p></div></div><div className="context-section"><div className="section-label-row"><span>当前主题</span><span className="quiet-label">Resolver</span></div><strong>{activeConversation?.activeTopic ?? '尚未识别主题'}</strong><p className="muted-copy">商品、订单与售后事实会优先于知识库。</p>{activeConversation?.taskBundle && <div className="task-bundle"><div className="section-label-row"><span>TaskBundle · {activeConversation.taskBundle.tasks.length}/4</span><span className="status-badge is-waiting">{taskStatusLabel(activeConversation.taskBundle.status)}</span></div>{activeConversation.taskBundle.tasks.map((task) => <div className="task-row" key={task.id}><span>{task.intent}</span><small>{taskStatusLabel(task.status)}</small></div>)}</div>}</div><div className="context-section"><div className="section-label-row"><span>快捷短语</span><button type="button" className="text-button">管理</button></div><div className="quick-phrases"><button type="button" onClick={() => setComposer('您好，我来帮您核对一下订单信息。')}>核对订单</button><button type="button" onClick={() => setComposer('我先为您确认库存和发货时效。')}>确认库存</button><button type="button" onClick={() => setComposer('请稍等，我为您转接人工客服。')}>转人工</button></div></div><div className="context-section source-list"><div className="section-label-row"><span>发送链路</span><span className={`status-badge ${sendOutbox?.status === 'SENT' ? 'is-positive' : sendOutbox?.status === 'FAILED' || sendOutbox?.status === 'UNCERTAIN' ? 'is-danger' : 'is-waiting'}`}>{sendOutboxStatusLabel(sendOutbox?.status)}</span></div><span>✓ SendGuard · lastMessage / sequence / Context v{activeConversation?.contextVersion ?? 1}</span><span>✓ ReplyJob · {replyJobStatusLabel(activeConversation?.activeReplyJob?.status)}</span>{sendOutbox?.failureReason && <span className="inline-error">{sendOutbox.failureReason}</span>}</div></div> : contextTab === 'product' ? <div className="context-scroll"><div className="context-intro"><span>当前商品与推荐候选</span><small>{contextProductList.length} 个结果</small></div>{contextProductList.length === 0 ? <ContextProduct /> : contextProductList.map((product) => <ContextProduct product={product} key={product.id} />)}</div> : contextTab === 'order' ? <div className="context-scroll"><div className="context-intro"><span>当前买家订单</span><small>{orders.length} 个结果</small></div>{activeOrder ? <ContextOrder order={activeOrder} /> : orders.length > 0 ? orders.map((order) => <ContextOrder order={order} key={order.id} />) : <ContextOrder />}</div> : <div className="context-scroll memory-context"><div className="context-intro"><span>人工 CustomerMemory</span><small>仅当前店铺 / 买家</small></div><div className="memory-form"><select value={memoryForm.type} onChange={(event) => setMemoryForm((current) => ({ ...current, type: event.currentTarget.value as CustomerMemoryInputDto['type'] }))} aria-label="记忆类型"><option value="PREFERENCE">偏好</option><option value="PRODUCT_PREFERENCE">商品偏好</option><option value="ONGOING_CASE">进行中事项</option></select><input value={memoryForm.key} onChange={(event) => setMemoryForm((current) => ({ ...current, key: event.currentTarget.value }))} placeholder="记忆键，例如 size" aria-label="记忆键" /><input value={memoryForm.value} onChange={(event) => setMemoryForm((current) => ({ ...current, value: event.currentTarget.value }))} placeholder="人工维护的事实" aria-label="记忆内容" /><div className="memory-form-actions"><button type="button" className="primary-button compact-button" onClick={() => void saveMemory()} disabled={!activeBuyer || !memoryForm.key.trim() || !memoryForm.value.trim() || memoryAction !== ''}>{memoryAction.startsWith('edit') ? '保存修改' : '新增记忆'}</button>{editingMemoryId && <button type="button" className="text-button" onClick={() => { setEditingMemoryId(''); setMemoryForm({ type: 'PREFERENCE', key: '', value: '' }); }}>取消编辑</button>}</div></div>{memories.length === 0 ? <EmptyState title="暂无人工记忆" detail="只有人工主动保存的偏好、商品偏好或进行中事项会进入这里。" /> : memories.map((memory) => <article className={`memory-card memory-${memory.status.toLowerCase()}`} key={memory.id}><div><strong>{memory.key}</strong><p>{typeof memory.value.text === 'string' ? memory.value.text : JSON.stringify(memory.value)}</p><small>{memory.type} · {memory.status}{memory.expiresAt ? ` · ${readableDate(memory.expiresAt)} 到期` : ''}</small></div><div className="memory-card-actions"><button type="button" className="text-button" onClick={() => { setEditingMemoryId(memory.id); setMemoryForm({ type: memory.type, key: memory.key, value: typeof memory.value.text === 'string' ? memory.value.text : JSON.stringify(memory.value) }); }}>编辑</button>{memory.status === 'ACTIVE' && <button type="button" className="text-button" onClick={() => void disableMemory(memory)} disabled={memoryAction !== ''}>停用</button>}<button type="button" className="text-button danger-button" onClick={() => void removeMemory(memory)} disabled={memoryAction !== ''}>删除</button></div></article>)}</div>}
      </aside>
      <DeveloperTracePanel open={traceOpen} loading={developerTraceLoading} error={developerTraceError} trace={developerTrace} conversationId={selectedConversationId} />
    </div>
  );
}

function BuyerSimulator({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [buyerId, setBuyerId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [detail, setDetail] = useState<Conversation>();
  const [composer, setComposer] = useState('');
  const [productId, setProductId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingText, setEditingText] = useState('');
  const [localMessages, setLocalMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);
  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);
  useEffect(() => {
    if (!shopId) return;
    let mounted = true;
    setLoading(true);
    setResourceError('');
    setBuyers([]);
    setProducts([]);
    setOrders([]);
    setConversations([]);
    Promise.all([getBuyers(token, shopId), getProducts(token, shopId), getConversations(token, shopId)])
      .then(([nextBuyers, nextProducts, nextConversations]) => {
        if (!mounted) return;
        setBuyers(nextBuyers);
        setProducts(nextProducts);
        setConversations(nextConversations);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setResourceError(errorMessage(error));
        setBuyers([]);
        setProducts([]);
        setConversations([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [refreshKey, shopId, token]);

  useEffect(() => {
    if (!buyerId || !buyers.some((buyer) => buyer.id === buyerId)) setBuyerId(buyers[0]?.id ?? '');
  }, [buyerId, buyers]);
  useEffect(() => {
    const matching = conversations.find((conversation) => conversation.buyerId === buyerId);
    setConversationId(matching?.id ?? '');
    setDetail(undefined);
    setLocalMessages([]);
    setEditingId('');
    if (!matching) return;
    let mounted = true;
    void getConversation(token, matching.id).then((conversation) => {
      if (mounted) setDetail(conversation);
    }).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [buyerId, conversations, token, refreshKey]);
  useEffect(() => {
    setProductId(products[0]?.id ?? '');
  }, [shopId, products]);
  useEffect(() => {
    setOrderId(orders[0]?.id ?? '');
  }, [buyerId, orders]);
  useEffect(() => {
    if (!shopId || !buyerId) {
      setOrders([]);
      return;
    }
    void getOrders(token, shopId, buyerId).then(setOrders).catch(() => setOrders([]));
  }, [buyerId, shopId, token, refreshKey]);

  const selectedBuyer = buyers.find((buyer) => buyer.id === buyerId);
  const selectedConversation = conversations.find((conversation) => conversation.id === conversationId);
  const messages = useMemo(() => {
    const map = new Map<string, Message>();
    [...(detail?.messages ?? selectedConversation?.messages ?? []), ...localMessages].forEach((message) => map.set(message.id, message));
    return Array.from(map.values()).sort(messageSort);
  }, [detail?.messages, localMessages, selectedConversation?.messages]);
  const activeShop = shops.find((shop) => shop.id === shopId);

  const appendLocalMessage = (message: Message | undefined, fallback: Partial<Message>) => {
    setLocalMessages((current) => [...current, { ...fallback, ...(message ?? {}), id: message?.id || `local-${Date.now()}-${current.length}` }]);
  };

  const sendText = async () => {
    const text = composer.trim();
    if (!text || !shopId || !buyerId) return;
    setSending(true);
    setNotice('');
    try {
      const sent = await sendBuyerMessage(token, { shopId, buyerId, text, conversationId: conversationId || undefined });
      const sentMessage = isMessage(sent) ? sent : undefined;
      appendLocalMessage(sentMessage, { role: 'BUYER', kind: 'TEXT', text, conversationId, buyerId, shopId, sentAt: new Date().toISOString() });
      if (sentMessage?.conversationId && sentMessage.conversationId !== conversationId) setConversationId(sentMessage.conversationId);
      setComposer('');
      setNotice('消息已送入 MockDouyin 管线');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const sendProduct = async () => {
    if (!productId || !shopId || !buyerId) return;
    setSending(true);
    setNotice('');
    try {
      const sent = await sendBuyerProductCard(token, { shopId, buyerId, productId, conversationId: conversationId || undefined });
      const sentMessage = isMessage(sent) ? sent : undefined;
      appendLocalMessage(sentMessage, { role: 'BUYER', kind: 'GOODS_CARD', productId, product: products.find((product) => product.id === productId), conversationId, buyerId, shopId, sentAt: new Date().toISOString() });
      if (sentMessage?.conversationId && sentMessage.conversationId !== conversationId) setConversationId(sentMessage.conversationId);
      setNotice('商品卡已发送');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const sendOrder = async () => {
    if (!orderId || !shopId || !buyerId) return;
    setSending(true);
    setNotice('');
    try {
      const sent = await sendBuyerOrderCard(token, { shopId, buyerId, orderId, conversationId: conversationId || undefined });
      const sentMessage = isMessage(sent) ? sent : undefined;
      appendLocalMessage(sentMessage, { role: 'BUYER', kind: 'ORDER_CARD', orderId, order: orders.find((order) => order.id === orderId), conversationId, buyerId, shopId, sentAt: new Date().toISOString() });
      if (sentMessage?.conversationId && sentMessage.conversationId !== conversationId) setConversationId(sentMessage.conversationId);
      setNotice('订单卡已发送');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async (messageId: string) => {
    const text = editingText.trim();
    if (!text) return;
    try {
      const updated = await editBuyerMessage(token, messageId, text);
      setLocalMessages((current) => {
        const base = messages.find((message) => message.id === messageId);
        const next = { ...(base ?? { id: messageId, role: 'BUYER', kind: 'TEXT' as const }), ...(isMessage(updated) ? updated : {}), text, status: isMessage(updated) ? (updated.status ?? 'EDITED') : 'EDITED' };
        return current.some((message) => message.id === messageId) ? current.map((message) => message.id === messageId ? next : message) : [...current, next];
      });
      setEditingId('');
      setNotice('消息已编辑，Context version 将由服务端推进');
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const recall = async (messageId: string) => {
    try {
      const updated = await recallBuyerMessage(token, messageId);
      setLocalMessages((current) => {
        const base = messages.find((message) => message.id === messageId);
        const next = { ...(base ?? { id: messageId, role: 'BUYER', kind: 'TEXT' as const }), ...(isMessage(updated) ? updated : {}), status: isMessage(updated) ? (updated.status ?? 'RECALLED') : 'RECALLED' };
        return current.some((message) => message.id === messageId) ? current.map((message) => message.id === messageId ? next : message) : [...current, next];
      });
      setNotice('消息已撤回');
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  return (
    <div className="simulator-page">
      <section className="simulator-header panel-surface">
        <div><span className="overline">EXTERNAL VIEW · MOCK DOUYIN</span><h2>买家模拟器</h2><p>以消费者视角发送事件，观察消息如何进入工作台。</p></div>
        <div className="simulator-selection"><label><span>店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><label><span>买家</span><select value={buyerId} onChange={(event) => setBuyerId(event.currentTarget.value)}>{buyers.length === 0 ? <option value="">等待买家快照</option> : buyers.map((buyer) => <option value={buyer.id} key={buyer.id}>{buyerName(buyer)}</option>)}</select></label></div>
      </section>
      <div className="simulator-layout">
        <section className="phone-stage">
          <div className="phone-stage-heading"><div><span className="overline">BUYER CHAT</span><strong>{activeShop?.name ?? '当前店铺'}</strong></div><span className="stage-live"><i /> LIVE PREVIEW</span></div>
          <div className="phone-shell">
            <div className="phone-notch" aria-hidden="true" />
            <header className="phone-header"><button type="button" className="phone-back" aria-label="返回">‹</button><Avatar label={buyerName(selectedBuyer)} tone="mint" /><div><strong>{activeShop?.name ?? '店铺客服'}</strong><small><i /> 在线 · 模拟消费者端</small></div><button type="button" className="phone-more" aria-label="更多">•••</button></header>
            <div className="phone-date">今天 {readableDate(new Date().toISOString())}</div>
            <div className="phone-messages">
              <div className="seller-welcome"><span className="welcome-spark">✦</span><strong>{activeShop?.name ?? '店铺'}的智能客服</strong><small>欢迎咨询商品、订单和售后问题</small></div>
              {loading ? <div className="phone-empty">正在读取对话…</div> : messages.length === 0 ? <div className="phone-empty"><span>○</span><strong>开始一次新的咨询</strong><small>你发送的内容会同步到客服工作台</small></div> : messages.map((message) => <div className="buyer-message-wrap" key={message.id}><MessageBubble message={message} dense />{message.role === 'BUYER' && message.status !== 'RECALLED' && message.status !== 'DELETED' && !message.id.startsWith('local-') && <div className="buyer-message-actions"><button type="button" onClick={() => { setEditingId(message.id); setEditingText(messageText(message)); }}>编辑</button><button type="button" onClick={() => void recall(message.id)}>撤回</button></div>}{editingId === message.id && <div className="inline-edit"><textarea value={editingText} onChange={(event) => setEditingText(event.currentTarget.value)} rows={2} /><div><button type="button" onClick={() => setEditingId('')}>取消</button><button className="save-mini" type="button" onClick={() => void saveEdit(message.id)}>保存</button></div></div>}</div>)}
            </div>
            <div className="phone-composer"><div className="phone-input-row"><button type="button" disabled title="图片消息暂不可用">＋</button><textarea value={composer} onChange={(event) => setComposer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendText(); } }} placeholder="输入咨询内容…" rows={1} /><button type="button" className="phone-send" onClick={() => void sendText()} disabled={!buyerTextSubmissionEnabled({ text: composer, shopId, buyerId, loading, sending })} aria-label="发送">↑</button></div><small>图片消息暂不可用</small></div>
          </div>
        </section>
        <aside className="simulator-tools">
          <div className="tool-heading"><div><span className="overline">EVENT COMPOSER</span><h2>发送测试事件</h2></div><span className="tool-status">{sending ? '发送中' : '就绪'}</span></div>
          <div className="selected-buyer-card"><Avatar label={buyerName(selectedBuyer)} tone="mint" /><div><strong>{buyerName(selectedBuyer)}</strong><span>{tagsFromBuyer(selectedBuyer).join(' · ') || '当前买家'} · {activeShop?.name ?? '当前店铺'}</span></div><span className="connection-check">✓</span></div>
          <div className="event-tool-section"><div className="section-label-row"><span>快捷卡片</span><span className="quiet-label">BUYER EVENT</span></div><label className="tool-select"><span>选择商品</span><select value={productId} onChange={(event) => setProductId(event.currentTarget.value)}><option value="">暂无商品快照</option>{products.map((product) => <option value={product.id} key={product.id}>{productName(product)}</option>)}</select></label><button type="button" className="event-button product-event" onClick={() => void sendProduct()} disabled={!productId || !buyerId || sending}><span className="event-button-icon">✦</span><span><strong>发送商品卡</strong><small>作为买家分享商品</small></span><b>→</b></button><label className="tool-select"><span>选择订单</span><select value={orderId} onChange={(event) => setOrderId(event.currentTarget.value)}><option value="">暂无订单快照</option>{orders.map((order) => <option value={order.id} key={order.id}>{orderName(order)} · {statusLabel(order.status)}</option>)}</select></label><button type="button" className="event-button order-event" onClick={() => void sendOrder()} disabled={!orderId || !buyerId || sending}><span className="event-button-icon">#</span><span><strong>发送订单卡</strong><small>作为买家分享订单</small></span><b>→</b></button></div>
          <div className="event-tool-section"><div className="section-label-row"><span>事件状态</span><span className="status-badge is-positive">REST + WS</span></div><div className="event-flow"><span className="flow-node">BUYER</span><i>→</i><span className="flow-node">ADAPTER</span><i>→</i><span className="flow-node is-emphasis">WORKBENCH</span></div><p className="muted-copy">每次事件均带当前 Workspace 凭据；收到 Socket 事件后会重新拉取资源快照。</p></div>
          {notice && <div className={`simulator-notice ${notice.includes('已') ? 'is-success' : ''}`} role="status">{notice}</div>}
          {resourceError && <div className="simulator-notice">{resourceError}</div>}
        </aside>
      </div>
    </div>
  );
}

function AdminMetricCard({ label, snapshot, detail, tone = '' }: { label: string; snapshot: AdminMetricSnapshot; detail: string; tone?: string }) {
  return <article className="admin-overview-metric"><span>{label}</span><strong className={tone}>{snapshot.value === null ? '—' : snapshot.value.toLocaleString('zh-CN')}{snapshot.value !== null && label === '已质检通过率' ? '%' : ''}</strong><small>{detail}</small></article>;
}

function metricSampleDetail(snapshot: AdminMetricSnapshot, available: string, unavailable: string): string {
  return snapshot.value === null ? unavailable : `${available} · 样本 ${snapshot.sampleSize}`;
}

function AdminOverviewPage({ token, shops, refreshKey }: Pick<SharedViewProps, 'token' | 'shops' | 'refreshKey'>) {
  const navigate = useNavigate();
  const overview = useQuery({
    queryKey: ['admin-overview', token, shops.map((shop) => shop.id).join(','), refreshKey],
    queryFn: async () => {
      const [conversationResults, usageResult, qualityResult] = await Promise.all([
        Promise.allSettled(shops.map((shop) => getConversations(token, shop.id))),
        Promise.allSettled([getUsageSummary(token)]).then(([result]) => result!),
        Promise.allSettled([getQualityReviews(token)]).then(([result]) => result!),
      ]);
      const conversationsByShop: Record<string, Conversation[]> = {};
      let failedSources = 0;
      shops.forEach((shop, index) => {
        const result = conversationResults[index];
        if (result?.status === 'fulfilled') conversationsByShop[shop.id] = result.value;
        else failedSources += 1;
      });
      const usage = usageResult.status === 'fulfilled' ? usageResult.value : undefined;
      if (!usage) failedSources += 1;
      const qualityReviews = qualityResult.status === 'fulfilled' ? qualityResult.value : [];
      if (qualityResult.status === 'rejected') failedSources += 1;
      return { conversationsByShop, usage, qualityReviews, failedSources };
    },
  });

  const conversationsByShop = overview.data?.conversationsByShop ?? {};
  const usage = overview.data?.usage;
  const qualityReviews = overview.data?.qualityReviews ?? [];
  const loading = overview.isLoading;
  const resourceError = overview.isError
    ? errorMessage(overview.error)
    : overview.data?.failedSources
      ? '部分 Workspace 数据暂不可用；以下仅展示已返回的真实样本，不推断缺失指标。'
      : '';

  const snapshot = buildAdminOverviewSnapshot(shops, conversationsByShop, usage, qualityReviews);
  const allConversations = Object.values(conversationsByShop).flat();
  const trend = buildConversationTrend(allConversations);
  const maxTrend = Math.max(1, ...trend.map((point) => point.count));

  return <div className="admin-page phase05-page admin-overview-page"><AdminTabs active="overview" /><Phase05AdminHeader overline="WORKSPACE OVERVIEW" title="数据概览" description="当前 Workspace 的真实 Demo 快照。缺少服务端汇总时显示不可用，不把调用量包装成商业 KPI。" />
    {resourceError && <div className="inline-notice" role="status">{resourceError}</div>}
    {loading ? <Phase05LoadingState label="正在读取店铺、会话、用量与质检快照…" /> : <>
      <section className="admin-overview-metric-grid" aria-label="Workspace 指标">
        <AdminMetricCard label="在线店铺" snapshot={snapshot.onlineShops} detail={metricSampleDetail(snapshot.onlineShops, 'CONNECTED 店铺', '暂无店铺快照')} tone="metric-positive" />
        <AdminMetricCard label="今日进线" snapshot={snapshot.todayInbound} detail={metricSampleDetail(snapshot.todayInbound, '按会话时间戳', '暂无有效会话时间戳')} />
        <AdminMetricCard label="AI 回复" snapshot={{ value: null, sampleSize: snapshot.aiUsage.sampleSize }} detail="当前 API 未提供已发送 AI 回复汇总；不从调用量推断。" />
        <AdminMetricCard label="人工接管" snapshot={snapshot.humanTakeover} detail={metricSampleDetail(snapshot.humanTakeover, '当前 humanActive 会话', '暂无会话快照')} tone="metric-warm" />
        <AdminMetricCard label="Fast Path" snapshot={snapshot.fastPath} detail={metricSampleDetail(snapshot.fastPath, 'FAST_CHAT usage calls', '暂无 usage 快照')} tone="metric-positive" />
        <AdminMetricCard label="LLM Reply" snapshot={snapshot.llmReply} detail={metricSampleDetail(snapshot.llmReply, 'REPLY_GENERATION calls', '暂无 purpose 分项')} />
        <AdminMetricCard label="AI Usage" snapshot={snapshot.aiUsage} detail={metricSampleDetail(snapshot.aiUsage, 'AI invocation calls', '暂无 usage 快照')} />
        <AdminMetricCard label="已质检通过率" snapshot={snapshot.qualityPassRate} detail={metricSampleDetail(snapshot.qualityPassRate, '已完成质检记录', '暂无已完成质检样本')} tone="metric-positive" />
      </section>
      <div className="admin-overview-grid">
        <section className="overview-chart-card panel-surface" aria-labelledby="conversation-trend-heading"><div className="phase05-list-heading"><div><span className="overline">CONVERSATION TREND</span><h3 id="conversation-trend-heading">会话趋势</h3></div><span className="quiet-label">最近 7 天 · {allConversations.length} 条返回样本</span></div><div className="overview-bars">{trend.map((point) => <div className="overview-bar-column" key={point.key}><span className="overview-bar-value">{point.count || '—'}</span><div className="overview-bar-track"><i style={{ height: `${Math.max(point.count ? 12 : 3, (point.count / maxTrend) * 100)}%` }} /></div><small>{point.label}</small></div>)}</div><p className="overview-footnote">趋势按各店铺 conversations 接口返回的时间戳计算，不代表全平台历史进线量。</p></section>
        <section className="overview-source-card panel-surface" aria-labelledby="overview-source-heading"><div className="phase05-list-heading"><div><span className="overline">SOURCE COVERAGE</span><h3 id="overview-source-heading">数据来源与边界</h3></div><span className="observe-only">NO FAKE KPI</span></div><div className="overview-source-list"><div><strong>店铺 / 连接</strong><span>Bootstrap · {shops.length} 家</span><em>真实</em></div><div><strong>会话趋势 / 接管</strong><span>按店铺 conversations 快照</span><em>{allConversations.length ? '样本' : '不可用'}</em></div><div><strong>AI Usage</strong><span>UsageSummary · calls / tokens / fallback</span><em>{usage ? '真实' : '不可用'}</em></div><div><strong>质检通过率</strong><span>仅统计已完成且有结论的记录</span><em>{snapshot.qualityPassRate.sampleSize ? `n=${snapshot.qualityPassRate.sampleSize}` : '暂无'}</em></div></div></section>
      </div>
      <div className="admin-overview-grid overview-secondary-grid"><section className="overview-list-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">POPULAR QUESTIONS</span><h3>热门问题</h3></div><span className="observe-only">NOT EXPOSED</span></div><EmptyState title="暂无问题聚合接口" detail="当前 Workspace API 只返回会话摘要，未提供可验证的热门问题聚合，因此不显示推测图表。" /></section><section className="overview-list-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">KNOWLEDGE / HANDOFF</span><h3>知识命中与转人工原因</h3></div><span className="observe-only">NOT EXPOSED</span></div><EmptyState title="暂无可用汇总" detail="知识命中与转人工原因尚未由现有 Workspace API 汇总；请进入知识、质检或工作台查看逐条证据。" /></section></div>
      <section className="overview-actions panel-surface"><div><span className="overline">NEXT OPERATIONS</span><h3>继续操作</h3><p>所有入口都保持在现有 MockDouyin 与 Workspace-scoped API 边界内。</p></div><div className="overview-action-buttons"><button className="primary-button" type="button" onClick={() => navigate('/admin/shops')}>管理店铺</button><button className="outline-button" type="button" onClick={() => navigate('/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => navigate('/admin/usage')}>查看 AI 用量</button><button className="outline-button" type="button" onClick={() => navigate('/workbench')}>打开工作台</button></div></section>
    </>}
  </div>;
}

function ShopsAdminPage({ shops, activeShopId, onShopChange }: Pick<SharedViewProps, 'shops' | 'activeShopId' | 'onShopChange'>) {
  const navigate = useNavigate();
  const selectedShopId = activeShopId || shops[0]?.id || '';
  const openForShop = (shopId: string, path: AppPath) => {
    onShopChange(shopId);
    navigate(path);
  };

  return <div className="admin-page phase05-page shops-admin-page"><AdminTabs active="shops" /><Phase05AdminHeader overline="SHOP CONTROL" title="店铺配置" description="查看当前 Workspace 的 MockDouyin 店铺连接状态与 ShopAIMode；设置入口复用已有工作台、商品学习与知识运营 API。" />
    {shops.length === 0 ? <EmptyState title="暂无店铺快照" detail="Bootstrap 尚未返回当前 Workspace 的店铺。" /> : <section className="shops-admin-grid" aria-label="店铺列表">{shops.map((shop) => { const selected = shop.id === selectedShopId; return <article className={`shop-admin-card panel-surface ${selected ? 'is-selected' : ''}`} key={shop.id}><div className="shop-admin-card-heading"><div className="shop-admin-identity"><span className="shop-admin-mark">{shop.name.slice(0, 1).toUpperCase()}</span><div><span className="overline">{shop.platform === 'DOUYIN_DEMO' ? 'MOCKDOUYIN' : shop.platform}</span><h3>{shop.name}</h3><small>{shop.externalShopId ? `External · ${shortId(shop.externalShopId)}` : 'External shop id 未返回'}</small></div></div><span className={`status-badge ${phase05StatusClass(shop.connectionState)}`}><i className={`shop-status-dot is-${shop.connectionState.toLowerCase()}`} />{connectionStateLabel(shop.connectionState)}</span></div><div className="shop-admin-facts"><div><span>ShopAIMode</span><strong>{modeLabel(shop.aiMode)}</strong><small>{shop.aiMode}</small></div><div><span>商品同步</span><strong>{shop.syncComplete ? '已完成' : '待同步'}</strong><small>{shop.syncComplete ? 'Bootstrap syncComplete' : '以商品学习页为准'}</small></div><div><span>平台</span><strong>MockDouyinAdapter</strong><small>V1 仅 Mock 平台</small></div></div><div className="shop-admin-actions"><button className="primary-button" type="button" onClick={() => openForShop(shop.id, '/workbench')}>打开工作台</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/knowledge')}>知识运营</button></div><div className="shop-admin-settings-note"><span className="note-icon">i</span><p><strong>设置入口</strong> 已连接到现有 Workspace 操作页；物流、发货、售后、欢迎语与违禁词未新增未验证的写入 API。</p></div></article>; })}</section>}
    <section className="shop-admin-boundary panel-surface"><div><span className="overline">FROZEN V1 BOUNDARY</span><h3>连接与权限边界</h3></div><div className="shop-boundary-grid"><div><strong>平台</strong><span>仅 MockDouyinAdapter</span><small>不接真实平台 API、Cookie 或 Token。</small></div><div><strong>AI 模式</strong><span>AUTO_ALLOWED · ASSIST_ONLY · MANUAL_ONLY</span><small>此页展示服务端快照；模式变更沿用已实现会话策略边界。</small></div><div><strong>可操作入口</strong><span>工作台 · 商品学习 · 知识运营</span><small>点击店铺卡片内按钮可带着当前店铺进入对应页面。</small></div></div></section>
  </div>;
}

function ProductLearningPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [products, setProducts] = useState<Product[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [jobs, setJobs] = useState<ProductLearningJob[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'sync' | 'learn' | 'retry' | ''>('');
  const [notice, setNotice] = useState('');
  const [resourceError, setResourceError] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);
  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);
  useEffect(() => {
    if (!shopId) return;
    let mounted = true;
    setLoading(true);
    setResourceError('');
    Promise.allSettled([getProducts(token, shopId), getKnowledge(token, { shopId }), getProductLearningJobs(token, shopId)]).then((results) => {
      if (!mounted) return;
      const [productResult, knowledgeResult, jobResult] = results;
      const errors: unknown[] = [];
      if (productResult.status === 'fulfilled') setProducts(productResult.value); else errors.push(productResult.reason);
      if (knowledgeResult.status === 'fulfilled') setKnowledge(knowledgeResult.value); else setKnowledge([]);
      if (jobResult.status === 'fulfilled') setJobs(jobResult.value); else setJobs([]);
      if (errors.length) setResourceError(errorMessage(errors[0]));
      setSelectedIds((current) => current.filter((id) => productResult.status === 'fulfilled' && productResult.value.some((product) => product.id === id)));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, shopId, token]);

  const activeShop = shops.find((shop) => shop.id === shopId);
  const latestJob = jobs[0];
  const latestJobItems = latestJob?.items ?? [];
  const learningItemByProduct = new Map(latestJobItems.map((item) => [item.productId, item]));
  const productWithStatus = products.map((product) => {
    const summary = product.learning ?? product.learningSummary;
    const learningItem = learningItemByProduct.get(product.id);
    const status = learningItem?.status ?? summary?.status ?? (latestJob?.status === 'RUNNING' ? 'PROCESSING' : undefined);
    return { product, summary, learningItem, status };
  });
  const completed = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'SUCCEEDED').length : productWithStatus.filter(({ status }) => status === 'SUCCEEDED').length;
  const processing = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'PROCESSING' || item.status === 'PENDING').length : productWithStatus.filter(({ status }) => status === 'PROCESSING' || status === 'PENDING').length;
  const failed = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'FAILED').length : productWithStatus.filter(({ status }) => status === 'FAILED').length;
  const progress = learningProgress(latestJob, products);
  const failedIds = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'FAILED').map((item) => item.productId) : productWithStatus.filter(({ status }) => status === 'FAILED').map(({ product }) => product.id);

  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const selectAll = () => setSelectedIds(selectedIds.length === products.length ? [] : products.map((product) => product.id));

  const runAction = async (action: 'sync' | 'learn' | 'retry') => {
    if (!shopId) return;
    setBusyAction(action);
    setNotice('');
    try {
      if (action === 'sync') {
        await syncProducts(token, shopId);
        setNotice('商品同步任务已提交');
      } else if (action === 'retry') {
        await startProductLearning(token, shopId, { productIds: selectedIds.length ? selectedIds : failedIds, retryFailed: true });
        setNotice('失败商品已重新加入学习队列');
      } else {
        const targetIds = selectedIds.length ? selectedIds : products.map((product) => product.id);
        await startProductLearning(token, shopId, { productIds: targetIds.length ? targetIds : undefined });
        setNotice(selectedIds.length ? `已提交 ${selectedIds.length} 个商品的学习` : '全量商品学习任务已提交');
      }
      setLocalRefresh((value) => value + 1);
      setSelectedIds([]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusyAction('');
    }
  };

  return <div className="admin-page product-learning-page"><AdminTabs active="products" /><section className="admin-page-header panel-surface"><div><span className="overline">PRODUCT INTELLIGENCE</span><h2>商品学习</h2><p>同步商品动态事实，再把稳定详情送入 ProductKnowledge 与索引。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><button className="outline-button" type="button" onClick={() => void runAction('sync')} disabled={busyAction !== '' || !shopId}>↻ 同步商品</button><button className="primary-button" type="button" onClick={() => void runAction('learn')} disabled={busyAction !== '' || !shopId}>{busyAction === 'learn' ? '提交中…' : '开始学习'}</button></div></section><div className="metric-grid admin-metrics"><article><span>商品总数</span><strong>{loading ? '—' : products.length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>已完成</span><strong className="metric-positive">{loading ? '—' : completed}</strong><small>ProductKnowledge ready</small></article><article><span>学习中</span><strong className="metric-warm">{loading ? '—' : processing}</strong><small>结构化抽取 / 索引</small></article><article><span>失败待重试</span><strong className={failed ? 'metric-danger' : ''}>{loading ? '—' : failed}</strong><small>{failed ? '需要重新学习' : '队列健康'}</small></article></div><section className="learning-progress-card panel-surface"><div className="progress-card-heading"><div><span className="overline">LEARNING JOB</span><h3>{latestJob ? `Job ${shortId(latestJob.id)}` : '尚未启动学习任务'}</h3></div><div className="job-state"><span className={`status-badge ${learningStatusClass(latestJob?.status)}`}>{learningStatusLabel(latestJob?.status)}</span><small>{latestJob?.updatedAt ? readableTime(latestJob.updatedAt) : '等待提交'}</small></div></div><div className="big-progress"><span style={{ width: `${progress}%` }} /></div><div className="progress-foot"><span><strong>{progress}%</strong> 已完成</span><span>{latestJob?.completed ?? completed} / {latestJob?.total ?? products.length} 个商品</span><span>{latestJob?.failed ?? failed} 个失败</span></div></section><div className="learning-main-grid"><section className="product-table-card panel-surface"><div className="table-heading"><div><span className="overline">CATALOG SNAPSHOT</span><h3>商品目录</h3></div><div className="table-actions"><button type="button" className="small-button" onClick={selectAll}>{selectedIds.length === products.length && products.length ? '取消全选' : '全选'}</button><button type="button" className="small-button retry-button" onClick={() => void runAction('retry')} disabled={busyAction !== '' || (!failedIds.length && !selectedIds.length)}>↻ 重试失败项</button></div></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="product-table-wrap"><table className="product-table"><thead><tr><th><span className="sr-only">选择</span></th><th>商品</th><th>SKU / 价格</th><th>库存</th><th>商品状态</th><th>学习状态</th><th>知识条目</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={8} className="table-empty">正在读取商品与学习快照…</td></tr> : products.length === 0 ? <tr><td colSpan={8} className="table-empty">{resourceError || '当前店铺暂无商品。'}</td></tr> : productWithStatus.map(({ product, summary, learningItem, status }) => { const sku = firstSku(product); const count = knowledge.filter((item) => item.productId === product.id).length || summary?.knowledgeCount || 0; return <tr key={product.id}><td><input type="checkbox" checked={selectedIds.includes(product.id)} onChange={() => toggleSelected(product.id)} aria-label={`选择${productName(product)}`} /></td><td><div className="product-cell"><span className="table-product-art">✦</span><div><strong>{productName(product)}</strong><small>{product.externalProductId ?? shortId(product.id)}</small></div></div></td><td><strong>{productPrice(product)}</strong><small className="table-subline">{sku?.externalSkuId ?? 'SKU —'}</small></td><td>{productInventory(product)}</td><td><span className={`status-badge ${product.status === 'ON_SHELF' ? 'is-positive' : 'is-muted'}`}>{statusLabel(product.status)}</span></td><td><span className={`learning-state ${learningStatusClass(status)}`}><i />{learningStatusLabel(status)}</span>{(learningItem?.reason || summary?.error) && <small className="table-error">{learningItem?.reason ?? summary?.error}</small>}</td><td><span className="knowledge-count">{count || '—'}</span></td><td><button type="button" className="row-menu" title="更多操作">•••</button></td></tr>; })}</tbody></table></div></section><aside className="runtime-observe"><section className="runtime-card panel-surface"><div className="runtime-card-heading"><div><span className="overline">AI RUNTIME</span><h3>运行状态</h3></div><span className="observe-only">OBSERVE ONLY</span></div><p>这里展示可观察结果；Provider、模型与密钥由服务端路由，不在前端配置。</p><div className="runtime-check"><span className="runtime-check-icon is-ready">✓</span><div><strong>结构化抽取</strong><small>Schema validation · repair once</small></div><em>READY</em></div><div className="runtime-check"><span className="runtime-check-icon is-ready">✓</span><div><strong>Hybrid RAG</strong><small>Keyword + vector · Top K 3</small></div><em>READY</em></div><div className="runtime-check"><span className="runtime-check-icon is-waiting">…</span><div><strong>当前索引</strong><small>{knowledge.length ? `${knowledge.filter((item) => item.indexStatus === 'READY').length} 条 Ready` : '等待知识快照'}</small></div><em>{knowledge.length ? 'LIVE' : 'PENDING'}</em></div></section><section className="runtime-note panel-surface"><span className="note-icon">i</span><div><strong>事实与知识分开</strong><p>价格、库存和订单状态始终来自实时业务上下文，不会进入向量检索。</p></div></section></aside></div>{notice && <div className={`action-toast ${notice.includes('已') || notice.includes('提交') ? 'is-success' : ''}`} role="status">{notice}</div>}</div>;
}

function importRowStatus(row: KnowledgeImportRow): 'READY' | 'DUPLICATE' | 'CONFLICT' | 'ERROR' {
  if (row.status === 'DUPLICATE' || row.status === 'CONFLICT' || row.status === 'ERROR') return row.status;
  if (String(row.status).toUpperCase() === 'NORMAL' || String(row.status).toUpperCase() === 'VALID') return 'READY';
  return 'READY';
}

function importRowStatusLabel(status: string): string {
  return status === 'READY' ? '可导入' : status === 'DUPLICATE' ? '重复' : status === 'CONFLICT' ? '冲突' : '错误';
}

function FormalKnowledgePage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState('ALL');
  const [businessFilter, setBusinessFilter] = useState('ALL');
  const [indexFilter, setIndexFilter] = useState('ALL');
  const [importOpen, setImportOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [preview, setPreview] = useState<KnowledgeImportPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [actionId, setActionId] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);
  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResourceError('');
    void getKnowledge(token, { shopId }).then((next) => {
      if (mounted) setItems(next);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setItems([]);
      setResourceError(errorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, shopId, token]);

  const activeShop = shops.find((shop) => shop.id === shopId);
  const filteredItems = useMemo(() => items.filter((item) => {
    const text = `${item.name ?? ''} ${item.question} ${item.answer} ${item.productTitle ?? ''}`.toLowerCase();
    return (scopeFilter === 'ALL' || item.scope === scopeFilter) && (sourceFilter === 'ALL' || item.sourceType === sourceFilter) && (businessFilter === 'ALL' || item.businessStatus === businessFilter) && (indexFilter === 'ALL' || item.indexStatus === indexFilter) && text.includes(query.toLowerCase());
  }), [businessFilter, indexFilter, items, query, scopeFilter, sourceFilter]);
  const enabledReady = items.filter((item) => item.businessStatus === 'ENABLED' && item.indexStatus === 'READY').length;
  const conflicts = items.filter((item) => item.businessStatus === 'CONFLICTED').length;
  const indexing = items.filter((item) => item.indexStatus === 'INDEXING' || item.indexStatus === 'PENDING').length;
  const importRows = preview?.rows ?? [];
  const importCounts = useMemo(() => importRows.reduce((counts, row) => {
    const status = importRowStatus(row);
    counts[status] += 1;
    return counts;
  }, { READY: 0, DUPLICATE: 0, CONFLICT: 0, ERROR: 0 }), [importRows]);
  const visibleImportCounts = useMemo(() => {
    if (importRows.length || !preview?.counts) return importCounts;
    return {
      READY: preview.counts.ready,
      DUPLICATE: preview.counts.duplicate,
      CONFLICT: preview.counts.conflict,
      ERROR: preview.counts.error,
    };
  }, [importCounts, importRows.length, preview?.counts]);

  const onFileSelected = async (file?: File) => {
    if (!file) return;
    setSelectedFile(file);
    setImportNotice('');
    setPreview(undefined);
    setPreviewLoading(true);
    const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type.includes('csv');
    let localRows: KnowledgeImportRow[] = [];
    if (isCsv) {
      try {
        const parsed = parseKnowledgeCsv(await file.text());
        const existing: ExistingKnowledgeMatch[] = items.map((item) => ({ productId: item.productId, question: item.question, answer: item.answer }));
        localRows = classifyImportRows(parsed, existing);
        setPreview({ id: 'local-preview', fileName: file.name, rows: localRows, status: 'LOCAL_PREVIEW' });
      } catch {
        setImportNotice('CSV 本地解析失败，将交由服务端校验。');
      }
    }
    try {
      const serverPreview = await previewKnowledgeImport(token, file, shopId);
      if (serverPreview.rows.length || !localRows.length) setPreview(serverPreview);
      else setPreview({ ...serverPreview, rows: localRows });
      setImportNotice(serverPreview.rows.length ? '已取得服务端校验结果。' : '导入任务已排队，等待服务端预览。');
    } catch (error) {
      if (localRows.length) setImportNotice('服务端预览接口暂不可用，当前展示本地校验结果。');
      else setImportNotice(errorMessage(error));
    } finally {
      setPreviewLoading(false);
    }
  };

  const commitImport = async () => {
    if (!preview?.id || preview.id === 'local-preview') {
      setImportNotice('当前只有本地预览，等待服务端返回导入任务 ID 后才能确认。');
      return;
    }
    setActionId(`import-${preview.id}`);
    try {
      await commitKnowledgeImport(token, preview.id, shopId);
      setImportNotice('正常行已确认导入；重复、冲突和错误行保持隔离。');
      setPreview(undefined);
      setSelectedFile(undefined);
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setImportNotice(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  const reindex = async (item: KnowledgeItem) => {
    setActionId(`reindex-${item.id}`);
    try {
      await reindexKnowledge(token, item.id, shopId);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, indexStatus: 'INDEXING' } : entry));
    } catch (error) {
      setResourceError(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  const remove = async (item: KnowledgeItem) => {
    setActionId(`delete-${item.id}`);
    try {
      await deleteKnowledge(token, item.id, shopId);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, businessStatus: 'DELETED' } : entry));
    } catch (error) {
      setResourceError(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  return <div className="admin-page knowledge-page"><AdminTabs active="knowledge" /><section className="admin-page-header panel-surface"><div><span className="overline">KNOWLEDGE OPERATIONS</span><h2>知识运营</h2><p>管理店铺与商品知识，分离业务状态和索引状态，保留每次版本切换的证据。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><button className="primary-button" type="button" onClick={() => { setImportOpen(true); setImportNotice(''); setPreview(undefined); setSelectedFile(undefined); }}><span className="button-plus">＋</span>导入知识</button></div></section><div className="metric-grid admin-metrics knowledge-metrics"><article><span>启用且可检索</span><strong className="metric-positive">{loading ? '—' : enabledReady}</strong><small>ENABLED + READY</small></article><article><span>全部知识</span><strong>{loading ? '—' : items.length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>索引处理中</span><strong className="metric-warm">{loading ? '—' : indexing}</strong><small>INDEXING / PENDING</small></article><article><span>冲突治理</span><strong className={conflicts ? 'metric-danger' : ''}>{loading ? '—' : conflicts}</strong><small>{conflicts ? '禁止自动检索' : '暂无冲突'}</small></article></div><section className="knowledge-list-card panel-surface"><div className="table-heading knowledge-heading"><div><span className="overline">SOURCE OF TRUTH</span><h3>正式知识</h3></div><span className="quiet-label">当前 Workspace · {filteredItems.length} 条</span></div><div className="knowledge-filters"><label className="knowledge-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索问题、答案或商品" /></label><select value={scopeFilter} onChange={(event) => setScopeFilter(event.currentTarget.value)}><option value="ALL">全部范围</option><option value="STORE">STORE 店铺</option><option value="PRODUCT">PRODUCT 商品</option></select><select value={sourceFilter} onChange={(event) => setSourceFilter(event.currentTarget.value)}><option value="ALL">全部来源</option><option value="MANUAL">MANUAL</option><option value="HUMAN_REVIEWED">HUMAN_REVIEWED</option><option value="AUTO_LEARNED">AUTO_LEARNED</option></select><select value={businessFilter} onChange={(event) => setBusinessFilter(event.currentTarget.value)}><option value="ALL">业务状态</option><option value="ENABLED">ENABLED</option><option value="DRAFT">DRAFT</option><option value="DISABLED">DISABLED</option><option value="OUTDATED">OUTDATED</option><option value="CONFLICTED">CONFLICTED</option><option value="DELETED">DELETED</option></select><select value={indexFilter} onChange={(event) => setIndexFilter(event.currentTarget.value)}><option value="ALL">索引状态</option><option value="READY">READY</option><option value="INDEXING">INDEXING</option><option value="PENDING">PENDING</option><option value="FAILED">FAILED</option></select></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="knowledge-table-wrap"><table className="knowledge-table"><thead><tr><th>问题 / 答案</th><th>范围</th><th>来源</th><th>业务状态</th><th>索引状态</th><th>版本</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-empty">正在读取知识快照…</td></tr> : filteredItems.length === 0 ? <tr><td colSpan={7} className="table-empty">{resourceError || '当前筛选没有知识条目。'}</td></tr> : filteredItems.map((item) => <tr key={item.id}><td><div className="knowledge-copy"><strong>{item.name ?? item.question}</strong>{item.name && <small className="knowledge-question">Q · {item.question}</small>}<small>A · {item.answer}</small>{item.productTitle && <em>{item.productTitle}</em>}</div></td><td><span className={`scope-badge scope-${item.scope.toLowerCase()}`}>{knowledgeScopeLabel(item.scope)}</span></td><td><span className="source-label">{knowledgeSourceLabel(item.sourceType)}</span></td><td><span className={`status-badge ${knowledgeStatusClass(item.businessStatus)}`}>{knowledgeBusinessLabel(item.businessStatus)}</span></td><td><span className={`index-label ${knowledgeStatusClass(item.indexStatus)}`}><i />{knowledgeIndexLabel(item.indexStatus)}</span></td><td><span className="version-label">v{knowledgeVersion(item)}</span></td><td><div className="row-actions"><button type="button" title="重新索引" onClick={() => void reindex(item)} disabled={actionId !== '' || item.businessStatus === 'DELETED'}>↻</button><button type="button" title="Soft delete" onClick={() => void remove(item)} disabled={actionId !== '' || item.businessStatus === 'DELETED'}>×</button></div></td></tr>)}</tbody></table></div></section>{importOpen && <div className="import-overlay" role="dialog" aria-modal="true" aria-labelledby="import-heading"><div className="import-drawer"><div className="import-drawer-heading"><div><span className="overline">KNOWLEDGE IMPORT</span><h2 id="import-heading">导入问答知识</h2><p>CSV / XLSX · 三列模板 · 不做整批回滚</p></div><button type="button" className="icon-button" onClick={() => setImportOpen(false)} aria-label="关闭">×</button></div><div className="import-template"><span className="template-icon">CSV</span><div><strong>商品ID（可选） · 问题 · 答案</strong><small>商品 ID 为空自动归类 STORE；填写后归类 PRODUCT</small></div><a href="/seed/knowledge-import-template.csv" download>下载模板</a></div><label className="file-drop"><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void onFileSelected(event.currentTarget.files?.[0])} /><span className="upload-icon">↑</span><strong>{selectedFile ? selectedFile.name : '选择或拖入文件'}</strong><small>支持 CSV / XLSX，服务端会再次校验编码、表头与长度</small></label>{previewLoading && <div className="preview-loading"><span className="loading-spinner" />正在生成预览…</div>}{preview && <><div className="import-counts"><div className="import-count is-ready"><strong>{visibleImportCounts.READY}</strong><span>可导入</span></div><div className="import-count is-duplicate"><strong>{visibleImportCounts.DUPLICATE}</strong><span>重复</span></div><div className="import-count is-conflict"><strong>{visibleImportCounts.CONFLICT}</strong><span>冲突</span></div><div className="import-count is-error"><strong>{visibleImportCounts.ERROR}</strong><span>错误</span></div></div><div className="import-preview-table"><table><thead><tr><th>行</th><th>范围 / 商品</th><th>问题</th><th>答案</th><th>校验</th></tr></thead><tbody>{importRows.length === 0 ? <tr><td colSpan={5} className="table-empty">任务已创建，服务端准备预览。</td></tr> : importRows.map((row) => { const status = importRowStatus(row); return <tr key={`${row.rowNumber}-${row.question}`} className={`import-row-${status.toLowerCase()}`}><td>{row.rowNumber}</td><td><span className={`scope-badge scope-${row.scope.toLowerCase()}`}>{knowledgeScopeLabel(row.scope)}</span><small>{row.productId || '店铺级'}</small></td><td>{row.question || '—'}</td><td>{row.answer || '—'}</td><td><span className={`import-status ${status.toLowerCase()}`}>{importRowStatusLabel(status)}</span>{row.reason && <small>{row.reason}</small>}</td></tr>; })}</tbody></table></div></>}{importNotice && <div className={`import-notice ${importNotice.includes('失败') || importNotice.includes('不可用') ? 'is-error' : ''}`} role="status">{importNotice}</div>}<div className="import-drawer-footer"><span>只有“可导入”行会进入 ENABLED；冲突需人工治理。</span><button type="button" className="outline-button" onClick={() => setImportOpen(false)}>取消</button><button type="button" className="primary-button" onClick={() => void commitImport()} disabled={!preview || !preview.id || previewLoading || actionId !== '' || preview.id === 'local-preview' || visibleImportCounts.READY === 0}>{actionId.startsWith('import-') ? '确认中…' : '确认导入'}</button></div></div></div>}</div>;
}

type KnowledgeAdminView = 'formal' | 'candidates' | 'conflicts';

function KnowledgeViewTabs({ active, onChange }: { active: KnowledgeAdminView; onChange: (view: KnowledgeAdminView) => void }) {
  return <div className="knowledge-view-tabs" role="tablist" aria-label="知识治理视图"><button type="button" className={active === 'formal' ? 'is-active' : ''} onClick={() => onChange('formal')}>正式知识 <small>Published</small></button><button type="button" className={active === 'candidates' ? 'is-active' : ''} onClick={() => onChange('candidates')}>候选知识 <small>Review</small></button><button type="button" className={active === 'conflicts' ? 'is-active' : ''} onClick={() => onChange('conflicts')}>冲突知识 <small>Resolve</small></button></div>;
}

function KnowledgePage({ initialView = 'formal', ...props }: SharedViewProps & { initialView?: KnowledgeAdminView }) {
  const navigate = useNavigate();
  const [view, setView] = useState<KnowledgeAdminView>(initialView);
  useEffect(() => setView(initialView), [initialView]);
  const changeView = (nextView: KnowledgeAdminView) => {
    setView(nextView);
    navigate(nextView === 'formal' ? '/admin/knowledge' : nextView === 'candidates' ? '/admin/knowledge/candidates' : '/admin/knowledge/conflicts');
  };
  return <div className="knowledge-admin-shell"><KnowledgeViewTabs active={view} onChange={changeView} />{view === 'formal' ? <FormalKnowledgePage {...props} /> : view === 'candidates' ? <KnowledgeCandidatesPage {...props} /> : <KnowledgeConflictsPage {...props} />}</div>;
}

function KnowledgeCandidatesPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionId, setActionId] = useState('');

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);
  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);
  useEffect(() => {
    if (!shopId) return;
    let mounted = true;
    setLoading(true);
    setResourceError('');
    void getKnowledgeCandidates(token, { shopId, ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}) }).then((next) => {
      if (mounted) setCandidates(next);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setCandidates([]);
      setResourceError(errorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [refreshKey, shopId, statusFilter, token]);

  const activeShop = shops.find((shop) => shop.id === shopId);
  const approve = async (candidate: KnowledgeCandidate) => {
    setActionId(`candidate-approve-${candidate.id}`);
    setNotice('');
    try {
      await approveKnowledgeCandidate(token, candidate.id, shopId);
      setCandidates((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, status: 'PUBLISHED' } : entry));
      setNotice('候选知识已批准并进入正式知识。');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setActionId('');
    }
  };
  const reject = async (candidate: KnowledgeCandidate) => {
    setActionId(`candidate-reject-${candidate.id}`);
    setNotice('');
    try {
      await rejectKnowledgeCandidate(token, candidate.id, shopId);
      setCandidates((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, status: 'REJECTED' } : entry));
      setNotice('候选知识已拒绝，保留审计记录。');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  return <div className="admin-page candidate-page"><AdminTabs active="knowledge" /><section className="admin-page-header panel-surface"><div><span className="overline">KNOWLEDGE REVIEW</span><h2>候选知识</h2><p>AI 学习与人工修订产生的候选必须显式审核后才会发布。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><select className="admin-filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="PENDING">待审核</option><option value="CONFLICTED">有冲突</option><option value="PUBLISHED">已发布</option><option value="REJECTED">已拒绝</option><option value="ALL">全部状态</option></select></div></section><div className="metric-grid admin-metrics moderation-metrics"><article><span>待审核候选</span><strong className="metric-warm">{loading ? '—' : candidates.filter((candidate) => candidate.status === 'PENDING').length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>候选总数</span><strong>{loading ? '—' : candidates.length}</strong><small>Candidate ledger</small></article><article><span>已发布</span><strong className="metric-positive">{loading ? '—' : candidates.filter((candidate) => candidate.status === 'PUBLISHED').length}</strong><small>HUMAN_REVIEWED</small></article><article><span>需治理</span><strong className={candidates.filter((candidate) => candidate.status === 'CONFLICTED').length ? 'metric-danger' : ''}>{loading ? '—' : candidates.filter((candidate) => candidate.status === 'CONFLICTED').length}</strong><small>显式冲突优先</small></article></div><section className="knowledge-list-card panel-surface"><div className="table-heading knowledge-heading"><div><span className="overline">CANDIDATE QUEUE</span><h3>审核队列</h3></div><span className="quiet-label">{candidates.length} 条候选</span></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="knowledge-table-wrap"><table className="knowledge-table candidate-table"><thead><tr><th>建议 Q / A</th><th>范围</th><th>来源</th><th>状态</th><th>更新时间</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={6} className="table-empty">正在读取候选快照…</td></tr> : candidates.length === 0 ? <tr><td colSpan={6} className="table-empty">{resourceError || '当前没有候选知识。'}</td></tr> : candidates.map((candidate) => <tr key={candidate.id}><td><div className="knowledge-copy"><strong>{candidate.proposedQuestion || '未填写问题'}</strong><small>A · {candidate.proposedAnswer || '未填写答案'}</small></div></td><td><span className={`scope-badge scope-${candidate.productId ? 'product' : 'store'}`}>{candidate.productId ? '商品' : '店铺'}</span><small className="candidate-id">{candidate.productId ?? 'STORE'}</small></td><td><span className="source-label">{knowledgeSourceLabel(candidate.source)}</span></td><td><span className={`status-badge candidate-status-${candidate.status.toLowerCase()}`}>{knowledgeCandidateStatusLabel(candidate.status)}</span></td><td><span className="source-label">{readableDate(candidate.updatedAt)}</span></td><td><div className="candidate-actions"><button type="button" onClick={() => void approve(candidate)} disabled={actionId !== '' || !['PENDING', 'APPROVED'].includes(candidate.status)}>批准</button><button type="button" onClick={() => void reject(candidate)} disabled={actionId !== '' || candidate.status === 'PUBLISHED' || candidate.status === 'REJECTED'}>拒绝</button></div></td></tr>)}</tbody></table></div></section>{notice && <div className={`action-toast ${notice.includes('失败') || notice.includes('不可用') ? '' : 'is-success'}`} role="status">{notice}</div>}</div>;
}

function knowledgeCandidateStatusLabel(status?: string): string {
  const labels: Record<string, string> = { PENDING: '待审核', APPROVED: '已批准', PUBLISHED: '已发布', REJECTED: '已拒绝', DUPLICATE: '重复', CONFLICTED: '冲突' };
  return status ? labels[status] ?? status : '—';
}

interface ConflictResolutionCardProps {
  conflict: KnowledgeConflict;
  items: KnowledgeItem[];
  busy: boolean;
  onResolve: (conflict: KnowledgeConflict, resolution: KnowledgeConflictResolution, customQuestion?: string, customAnswer?: string) => void;
}

function ConflictResolutionCard({ conflict, items, busy, onResolve }: ConflictResolutionCardProps) {
  const [resolution, setResolution] = useState<KnowledgeConflictResolution>('KEEP_LEFT');
  const [customQuestion, setCustomQuestion] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const leftItem = items.find((item) => item.id === conflict.leftItemId);
  const rightItem = items.find((item) => item.id === conflict.rightItemId);
  const leftQuestion = conflict.left?.question || leftItem?.question || `条目 ${shortId(conflict.leftItemId)}`;
  const leftAnswer = conflict.left?.answer || leftItem?.answer || `版本 ${shortId(conflict.leftVersionId)} 暂无 Q/A 快照`;
  const rightQuestion = conflict.right?.question || rightItem?.question || `条目 ${shortId(conflict.rightItemId)}`;
  const rightAnswer = conflict.right?.answer || rightItem?.answer || `版本 ${shortId(conflict.rightVersionId)} 暂无 Q/A 快照`;
  const customRequired = resolution === 'MERGE' || resolution === 'CUSTOM';
  return <article className="conflict-card panel-surface"><div className="conflict-card-heading"><div><span className="overline">OPEN CONFLICT</span><h3>冲突 {shortId(conflict.id)}</h3></div><span className="status-badge is-danger">{conflict.status === 'OPEN' ? '待解决' : conflict.status}</span></div><div className="conflict-sides"><section className="conflict-side side-left"><span className="side-label">LEFT · {shortId(conflict.leftVersionId)}</span><strong>{leftQuestion}</strong><p>{leftAnswer}</p><small>{leftItem ? '已取得正式知识快照' : '后端暂未返回 Q/A，使用 ID fallback'}</small></section><span className="conflict-vs">VS</span><section className="conflict-side side-right"><span className="side-label">RIGHT · {shortId(conflict.rightVersionId)}</span><strong>{rightQuestion}</strong><p>{rightAnswer}</p><small>{rightItem ? '已取得正式知识快照' : '后端暂未返回 Q/A，使用 ID fallback'}</small></section></div><div className="conflict-resolution"><span className="side-label">RESOLUTION</span><div className="resolution-options">{(['KEEP_LEFT', 'KEEP_RIGHT', 'MERGE', 'CUSTOM'] as KnowledgeConflictResolution[]).map((option) => <button type="button" className={resolution === option ? 'is-selected' : ''} onClick={() => setResolution(option)} key={option}>{option}</button>)}</div>{customRequired && <div className="custom-resolution"><input value={customQuestion} onChange={(event) => setCustomQuestion(event.currentTarget.value)} placeholder="合并后的问题" /><textarea value={customAnswer} onChange={(event) => setCustomAnswer(event.currentTarget.value)} placeholder="合并后的答案" rows={2} /></div>}<button type="button" className="primary-button resolve-button" disabled={busy || (customRequired && (!customQuestion.trim() || !customAnswer.trim()))} onClick={() => onResolve(conflict, resolution, customQuestion, customAnswer)}>{busy ? '提交中…' : '提交解决方案'}</button></div></article>;
}

function KnowledgeConflictsPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [conflicts, setConflicts] = useState<KnowledgeConflict[]>([]);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionId, setActionId] = useState('');

  useEffect(() => {
    if (activeShopId && activeShopId !== shopId) setShopId(activeShopId);
  }, [activeShopId, shopId]);
  useEffect(() => {
    if (shopId) onShopChange(shopId);
  }, [onShopChange, shopId]);
  useEffect(() => {
    if (!shopId) return;
    let mounted = true;
    setLoading(true);
    setResourceError('');
    Promise.allSettled([getKnowledgeConflicts(token, { shopId, status: 'OPEN' }), getKnowledge(token, { shopId })]).then((results) => {
      if (!mounted) return;
      const [conflictResult, itemResult] = results;
      if (conflictResult.status === 'fulfilled') setConflicts(conflictResult.value); else setResourceError(errorMessage(conflictResult.reason));
      if (itemResult.status === 'fulfilled') setItems(itemResult.value);
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [refreshKey, shopId, token]);

  const resolve = async (conflict: KnowledgeConflict, resolution: KnowledgeConflictResolution, customQuestion?: string, customAnswer?: string) => {
    setActionId(`conflict-${conflict.id}`);
    setNotice('');
    try {
      await resolveKnowledgeConflict(token, conflict.id, { shopId, resolution, ...(customQuestion ? { customQuestion } : {}), ...(customAnswer ? { customAnswer } : {}) });
      setConflicts((current) => current.filter((entry) => entry.id !== conflict.id));
      setNotice('冲突解决方案已提交，等待知识快照刷新。');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setActionId('');
    }
  };

  return <div className="admin-page conflict-page"><AdminTabs active="knowledge" /><section className="admin-page-header panel-surface"><div><span className="overline">KNOWLEDGE CONFLICTS</span><h2>冲突治理</h2><p>冲突是 RAG 硬停止条件，必须明确保留一侧或提交人工编写的合并内容。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><span className="quiet-label">{conflicts.length} 个 OPEN</span></div></section>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="conflict-list">{loading ? <div className="table-empty panel-surface">正在读取冲突快照…</div> : conflicts.length === 0 ? <div className="table-empty panel-surface">{resourceError || '当前店铺没有待治理冲突。'}</div> : conflicts.map((conflict) => <ConflictResolutionCard conflict={conflict} items={items} busy={actionId === `conflict-${conflict.id}`} onResolve={resolve} key={conflict.id} />)}</div>{notice && <div className={`action-toast ${notice.includes('失败') || notice.includes('不可用') ? '' : 'is-success'}`} role="status">{notice}</div>}</div>;
}

function phase05StatusClass(status?: string): string {
  if (['SUCCEEDED', 'COMPLETED', 'PASS', 'RESOLVED'].includes(status ?? '')) return 'is-positive';
  if (['FAILED', 'FAIL', 'OPEN'].includes(status ?? '')) return 'is-danger';
  if (['RUNNING', 'PENDING', 'WAITING_APPROVAL', 'NEEDS_HUMAN', 'CORRECTION_DRAFTED', 'RESETTING'].includes(status ?? '')) return 'is-waiting';
  return 'is-muted';
}

const workflowEditorNodeTypes = new Set<WorkflowNodeType>([
  'TRIGGER',
  'CONDITION',
  'QUERY_PRODUCT',
  'QUERY_ORDER',
  'QUERY_LOGISTICS',
  'AI_GENERATE',
  'HUMAN_APPROVAL',
  'END',
]);
const workflowEditorConfigKeys = new Set(['intent', 'topN', 'expression', 'action']);

export function moveWorkflowNode(graph: WorkflowGraph, nodeId: string, position: { x: number; y: number }): WorkflowGraph {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('node position must be finite');
  if (!graph.nodes.some((node) => node.id === nodeId)) throw new Error(`node ${nodeId} not found`);
  return { ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, position: { ...position } } : node) };
}

export function addWorkflowNode(graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph {
  if (!workflowEditorNodeTypes.has(node.type)) throw new Error('node type is outside the V1 allowlist');
  if (!node.id || graph.nodes.some((entry) => entry.id === node.id)) throw new Error('duplicate node id');
  if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new Error('node position must be finite');
  return { ...graph, nodes: [...graph.nodes, { ...node, position: { ...node.position }, config: { ...node.config } }] };
}

export function removeWorkflowNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  if (!graph.nodes.some((node) => node.id === nodeId)) throw new Error(`node ${nodeId} not found`);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

function workflowHasPath(graph: WorkflowGraph, from: string, to: string): boolean {
  const visited = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (current === to) return true;
    visited.add(current);
    for (const edge of graph.edges) if (edge.source === current) pending.push(edge.target);
  }
  return false;
}

export function addWorkflowEdge(graph: WorkflowGraph, edge: WorkflowEdge): WorkflowGraph {
  if (!edge.id || graph.edges.some((entry) => entry.id === edge.id)) throw new Error('duplicate edge id');
  if (edge.source === edge.target || !graph.nodes.some((node) => node.id === edge.source) || !graph.nodes.some((node) => node.id === edge.target)) throw new Error('edge endpoint is missing');
  if (graph.edges.some((entry) => entry.source === edge.source && entry.target === edge.target)) throw new Error('duplicate edge');
  const sourceNode = graph.nodes.find((node) => node.id === edge.source);
  if (sourceNode?.type === 'CONDITION') {
    if (edge.condition !== 'true' && edge.condition !== 'false') throw new Error('condition branch must be true or false');
    if (graph.edges.some((entry) => entry.source === edge.source && entry.condition === edge.condition)) throw new Error('condition branch must be unique');
  } else if (edge.condition !== undefined) {
    throw new Error('condition is only valid for CONDITION branches');
  }
  if (workflowHasPath(graph, edge.target, edge.source)) throw new Error('edge would create a cycle');
  return { ...graph, edges: [...graph.edges, { ...edge }] };
}

export function removeWorkflowEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  if (!graph.edges.some((edge) => edge.id === edgeId)) throw new Error(`edge ${edgeId} not found`);
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

export function updateWorkflowNodeConfig(graph: WorkflowGraph, nodeId: string, key: 'intent' | 'topN' | 'expression' | 'action', value: string | number): WorkflowGraph {
  if (!workflowEditorConfigKeys.has(key)) throw new Error('config key is not editable in V1');
  if (!graph.nodes.some((node) => node.id === nodeId)) throw new Error(`node ${nodeId} not found`);
  if (key === 'topN') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error('config value is invalid');
  } else if (typeof value !== 'string' || !value.trim()) {
    throw new Error('config value is invalid');
  }
  return { ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, config: { ...node.config, [key]: value } } : node) };
}

export function updateWorkflowSettings(graph: WorkflowGraph, patch: Partial<WorkflowGraph['settings']>): WorkflowGraph {
  const settings = { ...graph.settings, ...patch };
  if (!Number.isSafeInteger(settings.maxSteps) || settings.maxSteps < 1 || settings.maxSteps > 20 || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 30_000) throw new Error('workflow settings are invalid');
  return { ...graph, settings };
}

export function workflowGraphEquals(left: WorkflowGraph, right: WorkflowGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isActionProposalDecisionEnabled(status: string): boolean {
  return status === 'WAITING_APPROVAL';
}

const workflowNodeLabels: Record<string, string> = {
  TRIGGER: '触发器',
  CONDITION: '条件',
  QUERY_PRODUCT: '查询商品',
  QUERY_ORDER: '查询订单',
  QUERY_LOGISTICS: '查询物流',
  AI_GENERATE: 'AI 生成',
  HUMAN_APPROVAL: '人工审批',
  END: '结束',
};

function WorkflowGraphCanvas({ graph, selectedNodeId, onSelectNode, onMoveNode }: { graph?: WorkflowGraph; selectedNodeId?: string; onSelectNode?: (nodeId: string) => void; onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void }) {
  if (!graph) return <EmptyState title="暂无 Graph 快照" detail="服务端尚未返回草稿或已发布版本的 Graph。" />;
  const maxX = Math.max(920, ...graph.nodes.map((node) => node.position.x + 190));
  const maxY = Math.max(320, ...graph.nodes.map((node) => node.position.y + 92));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | undefined>(undefined);
  const pointerPosition = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ((event.clientX - rect.left) / rect.width) * maxX, y: ((event.clientY - rect.top) / rect.height) * maxY };
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current || !onMoveNode) return;
    const position = pointerPosition(event);
    onMoveNode(dragRef.current.nodeId, { x: Math.max(0, Math.round(position.x - dragRef.current.offsetX)), y: Math.max(0, Math.round(position.y - dragRef.current.offsetY)) });
  };
  const handlePointerUp = () => { dragRef.current = undefined; };
  return <div className="workflow-canvas-wrap"><svg ref={svgRef} className={`workflow-canvas ${onMoveNode ? 'is-editable' : ''}`} viewBox={`0 0 ${maxX} ${maxY}`} role="img" aria-label="Workflow 节点与连线" onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp}><defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9ccfbd" /></marker></defs><g className="workflow-edges">{graph.edges.map((edge) => { const source = nodes.get(edge.source); const target = nodes.get(edge.target); if (!source || !target) return null; return <line key={edge.id} x1={source.position.x + 82} y1={source.position.y + 36} x2={target.position.x} y2={target.position.y + 36} markerEnd="url(#workflow-arrow)" />; })}</g><g className="workflow-nodes">{graph.nodes.map((node) => <g key={node.id} className={selectedNodeId === node.id ? 'is-selected' : ''} transform={`translate(${node.position.x},${node.position.y})`} onClick={() => onSelectNode?.(node.id)} onPointerDown={(event) => { if (!onMoveNode || !svgRef.current) return; event.stopPropagation(); const position = pointerPosition(event as unknown as React.PointerEvent<SVGSVGElement>); dragRef.current = { nodeId: node.id, offsetX: position.x - node.position.x, offsetY: position.y - node.position.y }; }}><rect width="164" height="72" rx="10" /><text className="workflow-node-type" x="12" y="22">{workflowNodeLabels[node.type] ?? node.type}</text><text className="workflow-node-id" x="12" y="46">{node.id}</text></g>)}</g></svg><div className="workflow-canvas-footer"><span>节点 {graph.nodes.length} · 连线 {graph.edges.length}</span><span>maxSteps {graph.settings.maxSteps} · timeout {graph.settings.timeoutMs}ms</span></div></div>;
}

const workflowEditorNodeTypeList: WorkflowNodeType[] = ['TRIGGER', 'CONDITION', 'QUERY_PRODUCT', 'QUERY_ORDER', 'QUERY_LOGISTICS', 'AI_GENERATE', 'HUMAN_APPROVAL', 'END'];
type WorkflowEditorConfigKey = 'intent' | 'topN' | 'expression' | 'action';

function WorkflowEditor({ graph, dirty, onChange }: { graph: WorkflowGraph; dirty: boolean; onChange: (graph: WorkflowGraph) => void }) {
  const [selectedNodeId, setSelectedNodeId] = useState(graph.nodes[0]?.id ?? '');
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>('CONDITION');
  const [newNodeId, setNewNodeId] = useState('');
  const [edgeId, setEdgeId] = useState('');
  const [edgeSource, setEdgeSource] = useState(graph.nodes[0]?.id ?? '');
  const [edgeTarget, setEdgeTarget] = useState(graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? '');
  const [edgeCondition, setEdgeCondition] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(graph.nodes[0]?.id ?? '');
    if (!graph.nodes.some((node) => node.id === edgeSource)) setEdgeSource(graph.nodes[0]?.id ?? '');
    if (!graph.nodes.some((node) => node.id === edgeTarget)) setEdgeTarget(graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? '');
  }, [edgeSource, edgeTarget, graph.nodes, selectedNodeId]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const report = (operation: () => WorkflowGraph) => {
    try {
      onChange(operation());
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '编辑操作失败');
    }
  };
  const addNode = () => {
    const id = newNodeId.trim() || `${newNodeType.toLowerCase()}-${graph.nodes.length + 1}`;
    report(() => addWorkflowNode(graph, { id, type: newNodeType, position: { x: 60 + (graph.nodes.length % 4) * 220, y: 55 + Math.floor(graph.nodes.length / 4) * 120 }, config: {} }));
    setNewNodeId('');
    setSelectedNodeId(id);
  };
  const addEdge = () => {
    const id = edgeId.trim() || `edge-${graph.edges.length + 1}`;
    const sourceNode = graph.nodes.find((node) => node.id === edgeSource);
    report(() => addWorkflowEdge(graph, { id, source: edgeSource, target: edgeTarget, ...(sourceNode?.type === 'CONDITION' ? { condition: edgeCondition } : {}) }));
    setEdgeId('');
    setEdgeCondition('');
  };
  const configValue = (key: WorkflowEditorConfigKey): string | number => {
    const value = selectedNode?.config[key];
    return typeof value === 'string' || typeof value === 'number' ? value : '';
  };
  const edgeSourceNode = graph.nodes.find((node) => node.id === edgeSource);
  const usedConditions = new Set(graph.edges.filter((edge) => edge.source === edgeSource).map((edge) => edge.condition));
  return <section className="workflow-editor-panel panel-surface"><div className="table-heading"><div><span className="overline">DRAFT EDITOR</span><h3>Workflow Graph</h3></div><span className={`status-badge ${dirty ? 'is-waiting' : 'is-positive'}`}>{dirty ? '未保存 Draft' : '已保存'}</span></div><div className="workflow-editor-layout"><div className="workflow-editor-main"><WorkflowGraphCanvas graph={graph} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onMoveNode={(nodeId, position) => report(() => moveWorkflowNode(graph, nodeId, position))} /><div className="workflow-edge-list"><div className="workflow-editor-subheading"><span>连线</span><small>source → target · V1 禁止循环</small></div>{graph.edges.length === 0 ? <div className="table-empty">暂无连线。</div> : graph.edges.map((edge) => <div className="workflow-edge-row" key={edge.id}><span>{edge.source} <i>→</i> {edge.target}{edge.condition ? <em>{edge.condition}</em> : null}</span><button type="button" onClick={() => report(() => removeWorkflowEdge(graph, edge.id))}>删除</button></div>)}</div></div><aside className="workflow-editor-controls"><div className="workflow-editor-subheading"><span>节点</span><small>仅 8 种 V1 类型</small></div><label className="compact-field"><span>当前节点</span><select value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.currentTarget.value)}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.id} · {node.type}</option>)}</select></label><div className="workflow-editor-inline"><input value={newNodeId} onChange={(event) => setNewNodeId(event.currentTarget.value)} placeholder="新节点 ID" aria-label="新节点 ID" /><select value={newNodeType} onChange={(event) => setNewNodeType(event.currentTarget.value as WorkflowNodeType)} aria-label="新节点类型">{workflowEditorNodeTypeList.map((type) => <option key={type} value={type}>{type}</option>)}</select><button className="outline-button" type="button" onClick={addNode}>添加</button></div><button className="workflow-danger-button" type="button" onClick={() => selectedNode && report(() => removeWorkflowNode(graph, selectedNode.id))} disabled={!selectedNode}>删除当前节点</button><div className="workflow-editor-subheading"><span>节点参数</span><small>{selectedNode?.type ?? '未选择'}</small></div>{selectedNode ? <div className="workflow-config-fields">{(['intent', 'topN', 'expression', 'action'] as WorkflowEditorConfigKey[]).map((key) => <label className="compact-field" key={key}><span>{key}</span><input type={key === 'topN' ? 'number' : 'text'} value={configValue(key)} onChange={(event) => report(() => updateWorkflowNodeConfig(graph, selectedNode.id, key, key === 'topN' ? Number(event.currentTarget.value) : event.currentTarget.value))} placeholder="未设置" /></label>)}</div> : <div className="table-empty">选择节点后编辑受控参数。</div>}<div className="workflow-editor-subheading"><span>Graph settings</span><small>执行上限</small></div><div className="workflow-config-fields settings-fields"><label className="compact-field"><span>maxSteps</span><input type="number" min="1" max="20" value={graph.settings.maxSteps} onChange={(event) => report(() => updateWorkflowSettings(graph, { maxSteps: Number(event.currentTarget.value) }))} /></label><label className="compact-field"><span>timeoutMs</span><input type="number" min="1" max="30000" value={graph.settings.timeoutMs} onChange={(event) => report(() => updateWorkflowSettings(graph, { timeoutMs: Number(event.currentTarget.value) }))} /></label></div><div className="workflow-editor-subheading"><span>新增连线</span><small>{edgeSourceNode?.type === 'CONDITION' ? 'CONDITION · 必须选择 true / false' : 'source → target'}</small></div><div className="workflow-edge-form"><input value={edgeId} onChange={(event) => setEdgeId(event.currentTarget.value)} placeholder="连线 ID" aria-label="连线 ID" /><select value={edgeSource} onChange={(event) => setEdgeSource(event.currentTarget.value)} aria-label="连线 source">{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select><span>→</span><select value={edgeTarget} onChange={(event) => setEdgeTarget(event.currentTarget.value)} aria-label="连线 target">{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select>{edgeSourceNode?.type === 'CONDITION' && <select value={edgeCondition} onChange={(event) => setEdgeCondition(event.currentTarget.value)} aria-label="连线 condition"><option value="">选择分支…</option><option value="true" disabled={usedConditions.has('true')}>true</option><option value="false" disabled={usedConditions.has('false')}>false</option></select>}<button className="outline-button" type="button" onClick={addEdge} disabled={graph.nodes.length < 2}>添加</button></div>{notice && <div className="workflow-editor-notice" role="alert">{notice}</div>}</aside></div></section>;
}

function WorkflowAdminPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<Workflow>();
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph>();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [runError, setRunError] = useState('');
  const [action, setAction] = useState('');
  const [proposalAction, setProposalAction] = useState('');
  const [notice, setNotice] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResourceError('');
    void getWorkflows(token).then((next) => {
      if (!mounted) return;
      setWorkflows(next);
      setSelectedId((current) => current && next.some((workflow) => workflow.id === current) ? current : next[0]?.id ?? '');
    }).catch((error: unknown) => {
      if (!mounted) return;
      setWorkflows([]);
      setSelectedId('');
      setResourceError(errorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, token]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(undefined);
      setDraftGraph(undefined);
      setRuns([]);
      return;
    }
    let mounted = true;
    setDetailLoading(true);
    setDetailError('');
    setRunError('');
    void Promise.allSettled([getWorkflow(token, selectedId), getWorkflowRuns(token, { workflowId: selectedId })]).then(([detailResult, runResult]) => {
      if (!mounted) return;
      if (detailResult.status === 'fulfilled') {
        setSelected(detailResult.value);
        const persistedGraph = detailResult.value.draftVersion?.graph ?? detailResult.value.activeVersion?.graph;
        setDraftGraph(persistedGraph ? JSON.parse(JSON.stringify(persistedGraph)) as WorkflowGraph : undefined);
      } else {
        setSelected(undefined);
        setDraftGraph(undefined);
        setDetailError(errorMessage(detailResult.reason));
      }
      if (runResult.status === 'fulfilled') setRuns(runResult.value); else { setRuns([]); setRunError(errorMessage(runResult.reason)); }
    }).finally(() => {
      if (mounted) setDetailLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, selectedId, token]);

  const runAction = async (kind: 'save' | 'publish' | 'enable' | 'disable') => {
    const persistedGraph = selected?.draftVersion?.graph ?? selected?.activeVersion?.graph;
    const graph = draftGraph ?? persistedGraph;
    const dirty = Boolean(draftGraph && persistedGraph && !workflowGraphEquals(draftGraph, persistedGraph));
    if (!selected || (kind === 'save' && (!draftGraph || !dirty))) return;
    setAction(kind);
    setNotice('');
    try {
      if (kind === 'save' && draftGraph) await saveWorkflowDraft(token, selected.id, draftGraph);
      if (kind === 'publish') {
        if (draftGraph && dirty) await saveWorkflowDraft(token, selected.id, draftGraph);
        await publishWorkflow(token, selected.id);
      }
      if (kind === 'enable') await enableWorkflow(token, selected.id);
      if (kind === 'disable') await disableWorkflow(token, selected.id);
      setNotice(kind === 'save' ? '草稿已提交保存' : kind === 'publish' ? '发布请求已提交' : kind === 'enable' ? '启用请求已提交' : '停用请求已提交');
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAction('');
    }
  };

  const decideProposal = async (proposalId: string, decision: 'approve' | 'reject', contextVersion?: number) => {
    setProposalAction(`${decision}:${proposalId}`);
    setNotice('');
    try {
      if (decision === 'approve') await approveActionProposal(token, proposalId, contextVersion === undefined ? {} : { expectedContextVersion: contextVersion });
      else await rejectActionProposal(token, proposalId, {});
      setNotice(decision === 'approve' ? 'Proposal 批准请求已提交' : 'Proposal 拒绝请求已提交');
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setProposalAction('');
    }
  };

  const persistedGraph = selected?.draftVersion?.graph ?? selected?.activeVersion?.graph;
  const graph = draftGraph ?? persistedGraph;
  const dirty = Boolean(draftGraph && persistedGraph && !workflowGraphEquals(draftGraph, persistedGraph));
  const latestRun = runs[0];
  return <div className="admin-page phase05-page workflow-admin-page"><AdminTabs active="workflows" /><Phase05AdminHeader overline="WORKFLOW CONTROL" title="工作流" description="固定 V1 节点与 Graph settings；版本、Run、NodeRun 与 Approval 均来自当前 Workspace 的真实快照。" />{notice && <div className="inline-notice" role="status">{notice}</div>}{loading ? <Phase05LoadingState label="正在读取工作流快照…" /> : resourceError ? <Phase05ErrorState message={resourceError} /> : workflows.length === 0 ? <EmptyState title="暂无工作流快照" detail="当前 Workspace 没有可展示的 Workflow 定义。" /> : <><section className="workflow-toolbar panel-surface"><label className="compact-field"><span>选择工作流</span><select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>{workflows.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name || shortId(workflow.id)}</option>)}</select></label>{selected && <><span className={`status-badge ${phase05StatusClass(selected.status)}`}>{statusLabel(selected.status)}{dirty ? ' · Draft' : ''}</span><button className="outline-button" type="button" onClick={() => void runAction('save')} disabled={action !== '' || !dirty}>{action === 'save' ? '保存中…' : '保存草稿'}</button><button className="outline-button" type="button" onClick={() => void runAction('publish')} disabled={action !== '' || !graph}>{action === 'publish' ? '发布中…' : '发布版本'}</button><button className="outline-button" type="button" onClick={() => void runAction(selected.status === 'PUBLISHED' ? 'disable' : 'enable')} disabled={action !== ''}>{action === 'enable' || action === 'disable' ? '提交中…' : selected.status === 'PUBLISHED' ? '停用' : '启用'}</button></>}</section>{detailLoading ? <Phase05LoadingState label="正在读取 Workflow 详情与运行日志…" /> : detailError ? <Phase05ErrorState message={detailError} /> : selected && <>{graph ? <WorkflowEditor graph={graph} dirty={dirty} onChange={setDraftGraph} /> : <section className="workflow-canvas-panel panel-surface"><WorkflowGraphCanvas graph={graph} /></section>}<section className="workflow-runtime-grid"><div className="phase05-resource-list panel-surface"><div className="phase05-list-heading"><span className="overline">WORKFLOW RUNS</span><span className="quiet-label">{runs.length} 条</span></div>{runError ? <div className="inline-notice">{runError}</div> : runs.length === 0 ? <div className="table-empty">暂无 Run 快照。</div> : runs.slice(0, 5).map((run) => <article className="phase05-list-row" key={run.id}><div><strong>{shortId(run.id)}</strong><small>{run.conversationId ? `Conversation · ${shortId(run.conversationId)}` : 'Conversation —'} · {run.nodeRuns?.length ?? 0} NodeRun</small></div><span className={`status-badge ${phase05StatusClass(run.status)}`}>{statusLabel(run.status)}</span></article>)}</div><div className="phase05-resource-list panel-surface"><div className="phase05-list-heading"><span className="overline">NODE RUN / APPROVAL</span><span className="quiet-label">{latestRun ? shortId(latestRun.id) : '—'}</span></div>{latestRun?.nodeRuns?.length ? latestRun.nodeRuns.map((nodeRun) => <article className="phase05-list-row" key={nodeRun.id}><div><strong>{nodeRun.nodeId}</strong><small>retry {nodeRun.retryCount} · {nodeRun.durationMs ?? '—'}ms</small></div><span className={`status-badge ${phase05StatusClass(nodeRun.status)}`}>{statusLabel(nodeRun.status)}</span></article>) : <div className="table-empty">暂无 NodeRun 快照。</div>}{latestRun?.proposals?.map((proposal) => { const decisionEnabled = isActionProposalDecisionEnabled(proposal.status); return <article className="phase05-approval-row" key={proposal.id}><div className="phase05-approval-summary"><strong>Approval · {proposal.type}</strong><span>{proposal.targetEntityType} · {shortId(proposal.targetEntityId)} · 风险 {proposal.riskLevel}</span><small>依据：{proposal.evidenceIds?.join(', ') || '未提供 evidence'} · context v{proposal.contextVersion}</small><code>{JSON.stringify(proposal.payload ?? {})}</code></div><span className={`status-badge ${phase05StatusClass(proposal.status)}`}>{statusLabel(proposal.status)}</span><div className="phase05-approval-actions"><button className="primary-button" type="button" onClick={() => void decideProposal(proposal.id, 'approve', proposal.contextVersion)} disabled={!decisionEnabled || proposalAction !== ''}>{proposalAction === `approve:${proposal.id}` ? '提交中…' : '批准'}</button><button className="outline-button" type="button" onClick={() => void decideProposal(proposal.id, 'reject')} disabled={!decisionEnabled || proposalAction !== ''}>{proposalAction === `reject:${proposal.id}` ? '提交中…' : '拒绝'}</button></div></article>; })}</div></section></>}</>}</div>;
}

function QualityAdminPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
  const [reviews, setReviews] = useState<QualityReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [conclusionDrafts, setConclusionDrafts] = useState<Record<string, QualityResult>>({});
  const [action, setAction] = useState('');
  const [notice, setNotice] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResourceError('');
    void getQualityReviews(token).then((next) => {
      if (mounted) setReviews(next);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setReviews([]);
      setResourceError(errorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, token]);

  const triggerReview = async () => {
    const id = conversationId.trim();
    if (!id) {
      setNotice('请输入 Conversation ID 后再触发质检。');
      return;
    }
    setAction('start');
    setNotice('');
    try {
      await startQualityReview(token, id);
      setConversationId('');
      setNotice('质检请求已提交，等待真实快照回写。');
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAction('');
    }
  };

  const submitConclusion = async (reviewId: string) => {
    const result = conclusionDrafts[reviewId] ?? 'PASS';
    setAction(`conclude:${reviewId}`);
    setNotice('');
    try {
      await concludeQualityReview(token, reviewId, result);
      setNotice('人工结论请求已提交。');
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAction('');
    }
  };

  return <div className="admin-page phase05-page quality-admin-page"><AdminTabs active="quality" /><Phase05AdminHeader overline="QUALITY REVIEW" title="质检" description="展示人工触发的规则检查、Judge 结果与人工结论；不虚构线上准确率或商业指标。" />{notice && <div className="inline-notice" role="status">{notice}</div>}<section className="quality-trigger panel-surface"><label className="compact-field"><span>Conversation ID</span><input value={conversationId} onChange={(event) => setConversationId(event.currentTarget.value)} placeholder="输入待质检会话 ID" aria-label="待质检 Conversation ID" /></label><button className="primary-button" type="button" onClick={() => void triggerReview()} disabled={action !== ''}>{action === 'start' ? '提交中…' : '人工触发质检'}</button></section>{loading ? <Phase05LoadingState label="正在读取质检快照…" /> : resourceError ? <Phase05ErrorState message={resourceError} /> : reviews.length === 0 ? <EmptyState title="暂无质检记录" detail="通过真实 Quality Review API 触发后，结果会显示在这里。" /> : <section className="phase05-resource-list panel-surface"><div className="phase05-list-heading"><span className="overline">QUALITY LEDGER</span><span className="quiet-label">{reviews.length} 条记录</span></div>{reviews.map((review) => { const conclusionEnabled = review.status === 'AUTO_REVIEWED' || review.status === 'NEEDS_HUMAN'; const selectedResult = conclusionDrafts[review.id] ?? review.humanResult ?? 'PASS'; return <article className="quality-review-row" key={review.id}><div className="phase05-list-row"><div><strong>{shortId(review.id)}</strong><small>Conversation · {shortId(review.conversationId)} · 样本 {review.sampleSize ?? '—'}</small></div><span className={`status-badge ${phase05StatusClass(review.status)}`}>{statusLabel(review.status)}</span></div><div className="quality-result-grid"><div><span className="overline">DETERMINISTIC</span>{review.deterministicResult ? <><strong className={review.deterministicResult.passed ? 'quality-pass' : 'quality-fail'}>{review.deterministicResult.passed ? 'PASS' : 'FAIL'}</strong><ul>{review.deterministicResult.checks.map((check) => <li key={`${review.id}-${check.key}`}>{check.key}: {check.passed ? '通过' : '失败'}{check.reason ? ` · ${check.reason}` : ''}</li>)}</ul></> : <span className="quiet-label">未返回</span>}</div><div><span className="overline">JUDGE</span>{review.judgeResult ? <><strong>{review.judgeResult.result}</strong><small>相关 {review.judgeResult.relevance} · 完整 {review.judgeResult.completeness} · grounded {review.judgeResult.groundedness} · tone {review.judgeResult.tone}</small><small>风险 {review.judgeResult.risk}{review.judgeResult.reasons?.length ? ` · ${review.judgeResult.reasons.join('；')}` : ''}</small></> : <span className="quiet-label">未返回</span>}</div><div><span className="overline">HUMAN FINAL</span><strong>{review.humanResult ?? '未提交'}</strong>{conclusionEnabled ? <div className="quality-conclusion-controls"><select value={selectedResult} onChange={(event) => setConclusionDrafts((current) => ({ ...current, [review.id]: event.currentTarget.value as QualityResult }))} aria-label={`${shortId(review.id)} 人工结论`}><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="NEEDS_HUMAN">NEEDS_HUMAN</option></select><button className="outline-button" type="button" onClick={() => void submitConclusion(review.id)} disabled={action !== ''}>{action === `conclude:${review.id}` ? '提交中…' : '提交结论'}</button></div> : <small>当前状态不可再提交人工结论。</small>}</div></div></article>; })}</section>}</div>;
}

export function incidentCanCorrect(status: string): boolean {
  return status === 'OPEN' || status === 'CORRECTION_DRAFTED';
}

export function incidentCanSetRootCause(status: string): boolean {
  return status === 'CORRECTED';
}

export function incidentCanAddRegression(status: string): boolean {
  return status === 'ROOT_CAUSE_FIXED';
}

export function incidentCanResolve(status: string): boolean {
  return status === 'REGRESSION_ADDED';
}

function IncidentAdminPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
  const [incidents, setIncidents] = useState<ReplyIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [incidentDrafts, setIncidentDrafts] = useState<Record<string, { correctedAnswer: string; sendToBuyer: boolean; rootCause: string; caseId: string }>>({});
  const [action, setAction] = useState('');
  const [notice, setNotice] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResourceError('');
    void getIncidents(token).then((next) => {
      if (mounted) setIncidents(next);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setIncidents([]);
      setResourceError(errorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, token]);

  const draftFor = (incident: ReplyIncident) => incidentDrafts[incident.id] ?? {
    correctedAnswer: incident.correctedAnswer ?? '',
    sendToBuyer: false,
    rootCause: incident.rootCause ?? '',
    caseId: incident.regressionCaseId ?? '',
  };

  const updateDraft = (incident: ReplyIncident, patch: Partial<ReturnType<typeof draftFor>>) => {
    setIncidentDrafts((current) => ({ ...current, [incident.id]: { ...draftFor(incident), ...patch } }));
  };

  const runIncidentAction = async (incident: ReplyIncident, kind: 'correction' | 'rootCause' | 'regression' | 'resolve') => {
    const draft = draftFor(incident);
    if (kind === 'correction' && !draft.correctedAnswer.trim()) {
      setNotice('请输入修正后的答案。');
      return;
    }
    if (kind === 'rootCause' && !draft.rootCause.trim()) {
      setNotice('请输入根因说明。');
      return;
    }
    setAction(`${kind}:${incident.id}`);
    setNotice('');
    try {
      if (kind === 'correction') await saveIncidentCorrection(token, incident.id, { correctedAnswer: draft.correctedAnswer.trim(), sendToBuyer: draft.sendToBuyer });
      if (kind === 'rootCause') await saveIncidentRootCause(token, incident.id, draft.rootCause.trim());
      if (kind === 'regression') await addIncidentRegression(token, incident.id, draft.caseId.trim() || undefined);
      if (kind === 'resolve') await resolveIncident(token, incident.id);
      setNotice(kind === 'correction' ? 'Correction 请求已提交。' : kind === 'rootCause' ? '根因请求已提交。' : kind === 'regression' ? 'Regression 请求已提交。' : 'Resolve 请求已提交。');
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAction('');
    }
  };

  return <div className="admin-page phase05-page incident-admin-page"><AdminTabs active="incidents" /><Phase05AdminHeader overline="REPLY INCIDENTS" title="错误治理" description="沿着 ReplyIncident 生命周期查看原答、人工修正、根因与回归状态。" />{notice && <div className="inline-notice" role="status">{notice}</div>}{loading ? <Phase05LoadingState label="正在读取错误治理快照…" /> : resourceError ? <Phase05ErrorState message={resourceError} /> : incidents.length === 0 ? <EmptyState title="暂无错误事件" detail="当前 Workspace 没有待治理的 ReplyIncident。" /> : <section className="phase05-resource-list panel-surface"><div className="phase05-list-heading"><span className="overline">INCIDENT LEDGER</span><span className="quiet-label">{incidents.length} 条记录</span></div>{incidents.map((incident) => { const draft = draftFor(incident); const correctionEnabled = incidentCanCorrect(incident.status); const rootCauseEnabled = incidentCanSetRootCause(incident.status); const regressionEnabled = incidentCanAddRegression(incident.status); const resolveEnabled = incidentCanResolve(incident.status); return <article className="incident-review-row" key={incident.id}><div className="phase05-list-row"><div><strong>{incident.errorType || '未分类错误'}</strong><small>Reply · {shortId(incident.replyId)} · {incident.originalAnswer ? incident.originalAnswer.slice(0, 90) : '原答不可用'}</small></div><span className={`status-badge ${phase05StatusClass(incident.status)}`}>{statusLabel(incident.status)}</span><span className={`status-badge ${phase05StatusClass(incident.severity)}`}>{incident.severity}</span></div><div className="incident-original"><span className="overline">ORIGINAL ANSWER</span><p>{incident.originalAnswer || '服务端未返回原答快照。'}</p></div><div className="incident-action-grid"><div><label className="compact-field"><span>Correction</span><textarea value={draft.correctedAnswer} onChange={(event) => updateDraft(incident, { correctedAnswer: event.currentTarget.value })} disabled={!correctionEnabled} rows={2} placeholder="输入人工修正后的答案" /></label><label className="incident-check"><input type="checkbox" checked={draft.sendToBuyer} onChange={(event) => updateDraft(incident, { sendToBuyer: event.currentTarget.checked })} disabled={!correctionEnabled} />发送给买家</label><button className="outline-button" type="button" onClick={() => void runIncidentAction(incident, 'correction')} disabled={!correctionEnabled || action !== ''}>{action === `correction:${incident.id}` ? '提交中…' : '保存修正'}</button></div><div><label className="compact-field"><span>Root cause</span><textarea value={draft.rootCause} onChange={(event) => updateDraft(incident, { rootCause: event.currentTarget.value })} disabled={!rootCauseEnabled} rows={2} placeholder="记录根因与修复方向" /></label><button className="outline-button" type="button" onClick={() => void runIncidentAction(incident, 'rootCause')} disabled={!rootCauseEnabled || action !== ''}>{action === `rootCause:${incident.id}` ? '提交中…' : '保存根因'}</button></div><div><label className="compact-field"><span>Regression case ID（可选）</span><input value={draft.caseId} onChange={(event) => updateDraft(incident, { caseId: event.currentTarget.value })} disabled={!regressionEnabled} placeholder="留空由服务端生成" /></label><button className="outline-button" type="button" onClick={() => void runIncidentAction(incident, 'regression')} disabled={!regressionEnabled || action !== ''}>{action === `regression:${incident.id}` ? '提交中…' : incident.status === 'REGRESSION_ADDED' ? '已加入 Regression' : '加入 Regression'}</button></div></div><div className="incident-footer-actions"><small>{incident.rootCause ? `根因：${incident.rootCause}` : incident.correctedAnswer ? '已有 Correction 快照' : '等待人工治理'}</small><button className="primary-button" type="button" onClick={() => void runIncidentAction(incident, 'resolve')} disabled={!resolveEnabled || action !== ''}>{action === `resolve:${incident.id}` ? '提交中…' : 'Resolve'}</button></div></article>; })}</section>}</div>;
}

function ScenarioLabPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setResourceError('');
    return getScenarios(token).then((next) => {
      setScenarios(next);
    }).catch((error: unknown) => {
      setScenarios([]);
      setResourceError(errorMessage(error));
    }).finally(() => {
      setLoading(false);
    });
  }, [token]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (scenario: Scenario, action: 'run' | 'reset') => {
    setBusyKey(`${action}:${scenario.key}`);
    setNotice('');
    try {
      if (action === 'run') await runScenario(token, scenario.key);
      else await resetScenario(token, scenario.key);
      setNotice(action === 'run' ? `${scenario.name} 已提交运行` : `${scenario.name} 已提交重置`);
      await load();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusyKey('');
    }
  };

  return <div className="admin-page phase05-page scenario-page"><Phase05AdminHeader overline="SCENARIO LAB · SYNTHETIC" title="场景实验室" description="固定八个 synthetic 场景，仅通过真实 API 读取与提交当前 Workspace 的运行/重置请求。" />{notice && <div className="inline-notice" role="status">{notice}</div>}{loading ? <Phase05LoadingState label="正在读取场景快照…" /> : resourceError ? <Phase05ErrorState message={resourceError} /> : scenarios.length === 0 ? <EmptyState title="暂无场景快照" detail="Scenario API 尚未返回当前 Workspace 的固定场景。" /> : <section className="phase05-resource-grid scenario-grid">{scenarios.map((scenario) => <article className="phase05-resource-card panel-surface" key={scenario.key}><div className="phase05-card-heading"><div><span className="overline">SYNTHETIC SCENARIO</span><h3>{scenario.name}</h3></div><span className={`status-badge ${phase05StatusClass(scenario.status)}`}>{statusLabel(scenario.status)}</span></div><p className="phase05-card-description">{scenario.description ?? scenario.expectedResult ?? '服务端未提供描述。'}</p>{scenario.steps && scenario.steps.length > 0 && <div className="scenario-steps">{scenario.steps.map((step) => <div key={step.key}><span className={`status-dot ${phase05StatusClass(step.status)}`} /><span>{step.label}</span><small>{statusLabel(step.status)}</small></div>)}</div>}<div className="phase05-card-actions"><button className="primary-button" type="button" onClick={() => void run(scenario, 'run')} disabled={busyKey !== ''}>{busyKey === `run:${scenario.key}` ? '提交中…' : '运行'}</button><button className="outline-button" type="button" onClick={() => void run(scenario, 'reset')} disabled={busyKey !== ''}>{busyKey === `reset:${scenario.key}` ? '提交中…' : '重置'}</button></div></article>)}</section>}</div>;
}

function PendingRoute({ path, bootstrap }: { path: AppPath; bootstrap?: BootstrapPayload }) {
  const item = navigationItems.find((entry) => entry.path === path) ?? defaultNavigationItem;
  return <section className="pending-route panel-surface"><span className="pending-orb">{navIcons[path]}</span><span className="overline">{item.note}</span><h2>{item.label}</h2><p>这个入口共享当前 Workspace。Phase 02 先聚焦消息管线、买家模拟器与客服工作台；其余业务模块会沿用同一套实时状态边界。</p><div className="pending-facts"><span><strong>{bootstrap?.seed.counts.shops ?? '—'}</strong> 店铺</span><span><strong>{bootstrap?.seed.counts.products ?? '—'}</strong> 商品</span><span><strong>{bootstrap?.seed.counts.knowledge ?? '—'}</strong> 知识条目</span></div></section>;
}

function FoundationError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return <section className="foundation-error panel-surface" role="alert"><span className="error-mark">!</span><div><span className="overline">CONNECTION CHECK</span><h2>尚未连接到 Foundation API</h2><p>{message}</p><button className="primary-button" type="button" onClick={onRetry}>重新连接</button></div></section>;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = resolveAppPath(location.pathname);
  const [foundation, setFoundation] = useState<FoundationState>({ status: 'loading' });
  const [socketStatus, setSocketStatus] = useState<WorkspaceSocketStatus>('idle');
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [realtimeEvent, setRealtimeEvent] = useState<WorkspaceSocketEvent>();
  const [activeShopId, setActiveShopId] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [traceOpen, setTraceOpen] = useState(() => traceRequestedBySearch(window.location.search));
  const hasInitialized = useRef(false);
  const socketStatusRef = useRef<WorkspaceSocketStatus>('idle');

  const loadFoundation = useCallback(async (forceNewWorkspace = false) => {
    setFoundation((current) => ({ status: 'loading', bootstrap: current.bootstrap }));
    try {
      let token = forceNewWorkspace ? null : readStoredWorkspaceToken();
      if (!token) {
        const session = await createWorkspace();
        token = session.token;
        storeWorkspaceToken(token);
      }
      try {
        const bootstrap = await getBootstrap(token);
        setFoundation({ status: 'ready', bootstrap });
        setActiveShopId((current) => current && bootstrap.shops.some((shop) => shop.id === current) ? current : (bootstrap.shops[0]?.id ?? ''));
      } catch (error) {
        if (!forceNewWorkspace && isWorkspaceCredentialError(error)) {
          clearStoredWorkspaceToken();
          const session = await createWorkspace();
          storeWorkspaceToken(session.token);
          const bootstrap = await getBootstrap(session.token);
          setFoundation({ status: 'ready', bootstrap });
          setActiveShopId(bootstrap.shops[0]?.id ?? '');
          return;
        }
        throw error;
      }
    } catch (error) {
      setFoundation({ status: 'error', error: error instanceof ApiError ? error.message : 'Foundation 初始化失败，请稍后重试。' });
    }
  }, []);

  const refreshFoundation = useCallback(async () => {
    const token = readStoredWorkspaceToken();
    if (!token) return;
    try {
      const bootstrap = await getBootstrap(token);
      setFoundation((current) => ({ ...current, status: 'ready', bootstrap, error: undefined }));
      setSnapshotVersion((value) => value + 1);
    } catch (error) {
      if (isWorkspaceCredentialError(error)) {
        clearStoredWorkspaceToken();
        await loadFoundation(true);
      }
    }
  }, [loadFoundation]);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    if (window.location.pathname === '/') navigate('/workbench', { replace: true });
    void loadFoundation();
  }, [loadFoundation, navigate]);

  const handleSocketStatus = useCallback((status: WorkspaceSocketStatus) => {
    const previous = socketStatusRef.current;
    socketStatusRef.current = status;
    setSocketStatus(status);
    if (status === 'connected' && previous === 'disconnected') void refreshFoundation();
  }, [refreshFoundation]);

  const handleSocketEvent = useCallback((event: WorkspaceSocketEvent) => {
    setRealtimeEvent(event);
    if (eventHasWorkspaceShape(event) || isPhase03SnapshotEvent(event)) setSnapshotVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    if (foundation.status !== 'ready') return;
    const token = readStoredWorkspaceToken();
    if (!token) return;
    return connectWorkspaceSocket(token, handleSocketStatus, handleSocketEvent);
  }, [foundation.status, foundation.bootstrap?.workspace.id, handleSocketEvent, handleSocketStatus]);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const token = readStoredWorkspaceToken();
      if (!token) {
        await loadFoundation(true);
        return;
      }
      await resetCurrentWorkspace(token);
      setSnapshotVersion((value) => value + 1);
      await loadFoundation();
    } catch (error) {
      if (isWorkspaceCredentialError(error)) {
        clearStoredWorkspaceToken();
        await loadFoundation(true);
      } else {
        setFoundation((current) => ({ ...current, status: 'error', error: errorMessage(error) }));
      }
    } finally {
      setIsResetting(false);
    }
  };

  const shops = foundation.bootstrap?.shops ?? [];
  const workspace = foundation.bootstrap?.workspace;
  const activeShop = shops.find((shop) => shop.id === activeShopId) ?? shops[0];
  const activeNav = path.startsWith('/admin/') ? navigationItems.find((item) => item.path === '/admin') ?? defaultNavigationItem : navigationItems.find((item) => item.path === path) ?? defaultNavigationItem;
  const routeTitle = path === '/admin'
    ? '数据概览'
    : path === '/admin/shops'
      ? '店铺配置'
      : path === '/admin/products'
        ? '商品学习'
        : path === '/admin/knowledge'
      ? '知识运营'
      : path === '/admin/knowledge/candidates'
        ? '候选知识'
        : path === '/admin/knowledge/conflicts'
          ? '冲突治理'
          : path === '/admin/workflows'
            ? '工作流'
            : path === '/admin/quality'
              ? '质检'
              : path === '/admin/incidents'
                ? '错误治理'
                : path === '/admin/usage'
                  ? '用量'
                  : path === '/admin/privacy'
                    ? '数据与隐私'
              : path === '/workbench'
                ? '消息工作台'
                : path === '/buyer-simulator'
                  ? '买家模拟器'
                  : path === '/scenario-lab'
                    ? '场景实验室'
                    : activeNav.label;
  const token = readStoredWorkspaceToken() ?? '';
  const socketLabel = socketStatus === 'connected' ? '实时已连接' : socketStatus === 'connecting' ? '正在连接' : socketStatus === 'disconnected' ? '等待重连' : '未连接';

  return (
    <main className={`app-shell route-${path.slice(1)}`}>
      <aside className="sidebar" aria-label="主导航">
        <a className="brand" href="/workbench" onClick={(event) => { event.preventDefault(); navigate('/workbench'); }}><span className="brand-mark">R</span><span className="brand-copy"><strong>Relay</strong><small>service console</small></span></a>
        <div className="workspace-switcher"><span className="workspace-avatar">W</span><div><small>当前 Workspace</small><strong>{shortId(workspace?.id)}</strong></div><span className="workspace-caret">⌄</span></div>
        <nav className="navigation" aria-label="Primary">{navigationItems.map((item) => <a className={`nav-item ${item.path === path || (item.path === '/admin' && path.startsWith('/admin/')) ? 'is-active' : ''}`} href={item.path} key={item.path} onClick={(event) => { event.preventDefault(); navigate(item.path); }}><span className="nav-icon">{navIcons[item.path]}</span><span className="nav-label"><strong>{item.label}</strong><small>{item.note}</small></span>{item.path === '/workbench' && <span className="nav-notification">{foundation.bootstrap?.seed.counts.buyers ?? ''}</span>}</a>)}</nav>
        <div className="sidebar-divider" />
        <div className="sidebar-shortcuts"><span className="overline">QUICK ACCESS</span><button type="button" onClick={() => navigate('/buyer-simulator')}><span>↗</span>打开买家模拟器</button><button type="button" onClick={() => setTraceOpen((value) => !value)}><span>⌘</span>Developer Trace <i className={traceOpen ? 'is-on' : ''} /></button></div>
        <div className="sidebar-footer"><span className={`status-dot ${socketStatus === 'connected' ? 'is-ready' : ''}`} /><span>{socketLabel}</span><small>MockDouyin</small></div>
      </aside>
      <section className="content">
        <header className="topbar"><div className="topbar-title"><div className="breadcrumb"><span>Relay</span><i>/</i><span>{activeNav.label}</span></div><h1>{routeTitle}</h1></div><div className="topbar-actions"><div className="current-shop-indicator"><span className={`shop-status-dot is-${(activeShop?.connectionState ?? 'DISCONNECTED').toLowerCase()}`} /><span>{activeShop?.name ?? '未选择店铺'}</span><small>{activeShop ? modeLabel(activeShop.aiMode) : '—'}</small></div><button className={`trace-toggle ${traceOpen ? 'is-on' : ''}`} type="button" onClick={() => setTraceOpen((value) => !value)}><span className="trace-eye">◎</span>Trace</button><button className="reset-button" type="button" onClick={() => void handleReset()} disabled={isResetting || foundation.status === 'loading'}>{isResetting ? '重置中…' : 'Reset demo'}</button><span className="user-avatar">A</span></div></header>
        {foundation.status === 'error' ? <FoundationError message={foundation.error} onRetry={() => void loadFoundation()} /> : foundation.status !== 'ready' || !token ? <section className="loading-screen panel-surface"><span className="loading-spinner" /><h2>正在准备 Workspace</h2><p>读取店铺、权限与实时连接…</p></section> : path === '/workbench' ? <Workbench token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} realtimeEvent={realtimeEvent} traceOpen={traceOpen} /> : path === '/buyer-simulator' ? <BuyerSimulator token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin' ? <AdminOverviewPage token={token} shops={shops} refreshKey={snapshotVersion} /> : path === '/admin/shops' ? <ShopsAdminPage shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} /> : path === '/admin/products' ? <ProductLearningPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/knowledge' || path === '/admin/knowledge/candidates' || path === '/admin/knowledge/conflicts' ? <KnowledgePage initialView={path === '/admin/knowledge/candidates' ? 'candidates' : path === '/admin/knowledge/conflicts' ? 'conflicts' : 'formal'} token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/workflows' ? <WorkflowAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/quality' ? <QualityAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/incidents' ? <IncidentAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/usage' ? <UsageAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/privacy' ? <DataPrivacyPage token={token} /> : path === '/scenario-lab' ? <ScenarioLabPage token={token} refreshKey={snapshotVersion} /> : <PendingRoute path={path} bootstrap={foundation.bootstrap} />}
        <footer className="page-footer"><span>Relay · 当前 Workspace 隔离</span><span>API {foundation.status === 'ready' ? 'READY' : 'PENDING'} · {socketLabel}</span></footer>
      </section>
    </main>
  );
}
