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
import { ConfirmDialog } from '../../components/ui/primitives';
import { AdminPageHeader as Phase05AdminHeader, AdminTabs } from '../admin/AdminChrome';
import { DataPrivacyPage } from '../privacy/DataPrivacyPage';
import { UsageAdminPage } from '../usage/UsageAdminPage';
import type {
  Bootstrap as BootstrapPayload,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from '@ai-customer-service/contracts';


import * as viewModel from '../shared/view-models';
const { defaultNavigationItem, readableTime, readableDate, shortId, buyerName, productName, orderName, statusLabel, errorMessage, modeLabel, connectionStateLabel, localDayKey, conversationTimestamp, metric, buildAdminOverviewSnapshot, buildConversationTrend, isConversationModeAllowed, conversationModeOptionLabel, replyJobStatusLabel, draftStatusLabel, sendOutboxStatusLabel, draftRemainingLabel, taskStatusLabel, tagsFromBuyer, firstSku, productPrice, productInventory, objectValue, redactTraceValue, redactDeveloperTracePayload, shouldLoadDeveloperTrace, traceRequestedBySearch, visibleDeveloperTraceEvents, isMessage, cardData, messageKindLabel, messageRoleLabel, messageSort, knowledgeScopeLabel, knowledgeSourceLabel, knowledgeBusinessLabel, knowledgeIndexLabel, knowledgeVersion, knowledgeStatusClass, learningStatusLabel, learningStatusClass, learningProgress, eventHasWorkspaceShape, isPhase03SnapshotEvent } = viewModel;
type FoundationState = viewModel.FoundationState;
type SharedViewProps = viewModel.SharedViewProps;
type AdminMetricSnapshot = viewModel.AdminMetricSnapshot;
type AdminOverviewSnapshot = viewModel.AdminOverviewSnapshot;
type ConversationTrendPoint = viewModel.ConversationTrendPoint;
type WorkbenchConversationMode = viewModel.WorkbenchConversationMode;

import { Avatar, MessageBubble, ShopRail, ContextProduct, ContextOrder, DeveloperTracePanel } from '../workbench/components';


export function BuyerSimulatorPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const shopId = activeShopId || shops[0]?.id || '';
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
  const [pendingRemovalId, setPendingRemovalId] = useState('');
  const [removingId, setRemovingId] = useState('');

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
    setRemovingId(messageId);
    try {
      const updated = await recallBuyerMessage(token, messageId);
      setLocalMessages((current) => {
        const base = messages.find((message) => message.id === messageId);
        const next = { ...(base ?? { id: messageId, role: 'BUYER', kind: 'TEXT' as const }), ...(isMessage(updated) ? updated : {}), status: isMessage(updated) ? (updated.status ?? 'RECALLED') : 'RECALLED' };
        return current.some((message) => message.id === messageId) ? current.map((message) => message.id === messageId ? next : message) : [...current, next];
      });
      setNotice('消息已从本演示会话隐藏；审计记录仍保留，不代表抖音平台已撤回');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setRemovingId('');
      setPendingRemovalId('');
    }
  };

  return (
    <div className="simulator-page">
      {pendingRemovalId && <ConfirmDialog busy={removingId === pendingRemovalId} confirmLabel="确认隐藏" description="消息仅会从本演示工作台的会话中隐藏，审计记录仍保留；不代表抖音平台消息已撤回。" onCancel={() => setPendingRemovalId('')} onConfirm={() => void recall(pendingRemovalId)} open title="从会话隐藏这条买家消息？" />}
      <section className="simulator-header panel-surface">
        <div><span className="overline">EXTERNAL VIEW · MOCK DOUYIN</span><h2>买家模拟器</h2><p>以消费者视角发送事件，观察消息如何进入工作台。</p></div>
        <div className="simulator-selection"><label><span>店铺</span><select value={shopId} onChange={(event) => onShopChange(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><label><span>买家</span><select value={buyerId} onChange={(event) => setBuyerId(event.currentTarget.value)}>{buyers.length === 0 ? <option value="">等待买家快照</option> : buyers.map((buyer) => <option value={buyer.id} key={buyer.id}>{buyerName(buyer)}</option>)}</select></label></div>
      </section>
      <div className="simulator-layout">
        <section className="phone-stage">
          <div className="phone-stage-heading"><div><span className="overline">BUYER CHAT</span><strong>{activeShop?.name ?? '当前店铺'}</strong></div><span className="stage-live"><i /> LIVE PREVIEW</span></div>
          <div className="phone-shell">
            <div className="phone-notch" aria-hidden="true" />
            <header className="phone-header"><Avatar label={buyerName(selectedBuyer)} tone="mint" /><div><strong>{activeShop?.name ?? '店铺客服'}</strong><small><i /> 在线 · 模拟消费者端</small></div></header>
            <div className="phone-date">今天 {readableDate(new Date().toISOString())}</div>
            <div className="phone-messages">
              <div className="seller-welcome"><span className="welcome-spark">✦</span><strong>{activeShop?.name ?? '店铺'}的智能客服</strong><small>欢迎咨询商品、订单和售后问题</small></div>
              {loading ? <div className="phone-empty">正在读取对话…</div> : messages.length === 0 ? <div className="phone-empty"><span>○</span><strong>开始一次新的咨询</strong><small>你发送的内容会同步到客服工作台</small></div> : messages.map((message) => <div className="buyer-message-wrap" key={message.id}><MessageBubble message={message} dense />{message.role === 'BUYER' && message.status !== 'RECALLED' && message.status !== 'DELETED' && !message.id.startsWith('local-') && <div className="buyer-message-actions"><button type="button" onClick={() => { setEditingId(message.id); setEditingText(messageText(message)); }}>编辑</button><button type="button" onClick={() => setPendingRemovalId(message.id)}>隐藏</button></div>}{editingId === message.id && <div className="inline-edit"><textarea value={editingText} onChange={(event) => setEditingText(event.currentTarget.value)} rows={2} /><div><button type="button" onClick={() => setEditingId('')}>取消</button><button className="save-mini" type="button" onClick={() => void saveEdit(message.id)}>保存</button></div></div>}</div>)}
            </div>
            <div className="phone-composer"><div className="phone-input-row"><textarea value={composer} onChange={(event) => setComposer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendText(); } }} placeholder="输入咨询内容…" rows={1} /><button type="button" className="phone-send" onClick={() => void sendText()} disabled={!buyerTextSubmissionEnabled({ text: composer, shopId, buyerId, loading, sending })} aria-label="发送">↑</button></div></div>
          </div>
        </section>
        <aside className="simulator-tools">
          <div className="tool-heading"><div><span className="overline">EVENT COMPOSER</span><h2>发送测试事件</h2></div><span className="tool-status">{sending ? '发送中' : '就绪'}</span></div>
          <div className="selected-buyer-card"><Avatar label={buyerName(selectedBuyer)} tone="mint" /><div><strong>{buyerName(selectedBuyer)}</strong><span>{tagsFromBuyer(selectedBuyer).join(' · ') || '当前买家'} · {activeShop?.name ?? '当前店铺'}</span></div><span className="connection-check">✓</span></div>
          <div className="event-tool-section"><div className="section-label-row"><span>快捷卡片</span><span className="quiet-label">BUYER EVENT</span></div><label className="tool-select"><span>选择商品</span><select value={productId} onChange={(event) => setProductId(event.currentTarget.value)}><option value="">暂无商品快照</option>{products.map((product) => <option value={product.id} key={product.id}>{productName(product)}</option>)}</select></label><button type="button" className="event-button product-event" onClick={() => void sendProduct()} disabled={!productId || !buyerId || sending}><span className="event-button-icon">✦</span><span><strong>发送商品卡</strong><small>作为买家分享商品</small></span><b>→</b></button><label className="tool-select"><span>选择订单</span><select value={orderId} onChange={(event) => setOrderId(event.currentTarget.value)}><option value="">暂无订单快照</option>{orders.map((order) => <option value={order.id} key={order.id}>{orderName(order)} · {statusLabel(order.status)}</option>)}</select></label><button type="button" className="event-button order-event" onClick={() => void sendOrder()} disabled={!orderId || !buyerId || sending}><span className="event-button-icon">#</span><span><strong>发送订单卡</strong><small>作为买家分享订单</small></span><b>→</b></button></div>
          <div className="event-tool-section"><div className="section-label-row"><span>同步状态</span><span className="status-badge is-positive">实时</span></div><p className="muted-copy">发送后会自动同步到客服工作台。</p></div>
          {notice && <div className={`simulator-notice ${notice.includes('已') ? 'is-success' : ''}`} role="status">{notice}</div>}
          {resourceError && <div className="simulator-notice">{resourceError}</div>}
        </aside>
      </div>
    </div>
  );
}
