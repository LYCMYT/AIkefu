import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { Drawer } from '../../components/ui/primitives';


import * as viewModel from '../shared/view-models';
const { defaultNavigationItem, readableTime, readableDate, shortId, buyerName, productName, orderName, statusLabel, errorMessage, modeLabel, connectionStateLabel, localDayKey, conversationTimestamp, metric, buildAdminOverviewSnapshot, buildConversationTrend, isConversationModeAllowed, conversationModeOptionLabel, replyJobStatusLabel, draftStatusLabel, sendOutboxStatusLabel, draftRemainingLabel, taskStatusLabel, tagsFromBuyer, firstSku, productPrice, productInventory, objectValue, redactTraceValue, redactDeveloperTracePayload, shouldLoadDeveloperTrace, traceRequestedBySearch, visibleDeveloperTraceEvents, isMessage, cardData, messageKindLabel, messageRoleLabel, messageSort, knowledgeScopeLabel, knowledgeSourceLabel, knowledgeBusinessLabel, knowledgeIndexLabel, knowledgeVersion, knowledgeStatusClass, learningStatusLabel, learningStatusClass, learningProgress, eventHasWorkspaceShape, isPhase03SnapshotEvent } = viewModel;
type FoundationState = viewModel.FoundationState;
type SharedViewProps = viewModel.SharedViewProps;
type AdminMetricSnapshot = viewModel.AdminMetricSnapshot;
type AdminOverviewSnapshot = viewModel.AdminOverviewSnapshot;
type ConversationTrendPoint = viewModel.ConversationTrendPoint;
type WorkbenchConversationMode = viewModel.WorkbenchConversationMode;


export function Avatar({ label, tone = 'mint' }: { label?: string; tone?: 'mint' | 'orange' | 'blue' | 'dark' }) {
  return <span className={`avatar avatar-${tone}`} aria-hidden="true">{(label ?? 'R').slice(0, 1)}</span>;
}

export function MessageBubble({ message, dense = false, actions }: { message: Message; dense?: boolean; actions?: ReactNode }) {
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
          <div className="message-bubble is-recalled">这条消息已从会话隐藏（审计记录保留）</div>
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
        {actions && <div className="message-actions">{actions}</div>}
      </div>
      {isBuyer && <Avatar label="买" tone="mint" />}
    </div>
  );
}

export function ShopRail({ shops, activeShopId, onShopChange }: Pick<SharedViewProps, 'shops' | 'activeShopId' | 'onShopChange'>) {
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

export function ContextProduct({ product }: { product?: Product }) {
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

export function ContextOrder({ order }: { order?: Order }) {
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

export function DeveloperTracePanel({ open, onClose, loading, error, trace, conversationId }: { open: boolean; onClose: () => void; loading: boolean; error?: string; trace?: DeveloperTrace; conversationId?: string }) {
  const events = visibleDeveloperTraceEvents(trace);
  return <Drawer className="workbench-trace-drawer" open={open} onClose={onClose} title="Developer Trace"><section className="workbench-trace-panel" aria-label="Developer Trace"><div className="trace-panel-heading"><div><span className="overline">DEVELOPER TRACE</span><h3>结构化诊断</h3></div><small>{trace?.traceId ? `Trace · ${trace.traceId}` : conversationId ? `Conversation · ${shortId(conversationId)}` : '未选择会话'}</small></div>{loading ? <Phase05LoadingState label="正在读取 Developer Trace…" /> : error ? <Phase05ErrorState message={error} /> : !trace ? <EmptyState title="暂无 Trace 快照" detail="选择会话后开启 Trace，服务端会返回结构化、已脱敏的事件。" /> : events.length === 0 ? <EmptyState title="暂无 Trace 事件" detail="当前会话尚未产生可展示的结构化诊断事件。" /> : <div className="trace-event-list">{events.map((event) => <article className="trace-event-row" key={event.id}><div><strong>{event.stage}</strong><small>{event.createdAt}</small></div><code>{JSON.stringify(event.payload, null, 2)}</code></article>)}</div>}<small className="trace-panel-note">仅显示结构化脱敏状态；不展示 prompt、模型私有推理或 Chain-of-Thought。</small></section></Drawer>;
}
