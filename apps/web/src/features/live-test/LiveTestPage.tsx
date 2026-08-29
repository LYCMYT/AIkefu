import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Edit3,
  MessageSquareText,
  Monitor,
  Package,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Smartphone,
  Store,
  UserRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  editBuyerMessage,
  getBuyers,
  getConversation,
  getConversations,
  getOrders,
  getProducts,
  messageText,
  recallBuyerMessage,
  resumeConversationAi,
  sendBuyerMessage,
  sendBuyerOrderCard,
  sendBuyerProductCard,
  sendConversationMessage,
  takeoverConversation,
  type Buyer,
  type Conversation,
  type Message,
  type MutationResult,
  type Order,
  type Product,
  type ShopSummary,
} from '../../api';
import type { WorkspaceSocketEvent, WorkspaceSocketStatus } from '../../workspace-socket';
import { ConfirmDialog } from '../../components/ui/primitives';
import {
  derivePipelineStages,
  eventConversationId,
  isVisibleMessage,
  mergeLiveMessages,
  resolveContextProduct,
  shouldRefreshLiveTest,
  type LiveTestSurface,
} from './live-test-model';
import './live-test.css';

export interface LiveTestPageProps {
  token: string;
  shops: ShopSummary[];
  activeShopId: string;
  onShopChange: (shopId: string) => void;
  refreshKey: number;
  /** The dynamic `/live-test/:shopId` segment, when the router has one. */
  requestedShopId?: string;
  /** Reuse Application's single workspace socket; this page deliberately does not open a second connection. */
  realtimeEvent?: WorkspaceSocketEvent;
  socketStatus?: WorkspaceSocketStatus;
  onOpenWorkbench?: (shopId: string) => void;
}

type NoticeTone = 'success' | 'warning' | 'error' | 'neutral';

interface Notice {
  text: string;
  tone: NoticeTone;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function buyerLabel(buyer?: Buyer): string {
  return buyer?.displayName ?? buyer?.name ?? buyer?.externalBuyerId ?? '未命名买家';
}

function productLabel(product?: Product): string {
  return product?.title ?? product?.name ?? product?.externalProductId ?? '未命名商品';
}

function orderLabel(order?: Order): string {
  return order?.externalOrderId ?? order?.orderNo ?? order?.id ?? '未命名订单';
}

function readableTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function mutationMessage(result: MutationResult): Message | undefined {
  if (!result || typeof result !== 'object' || !('id' in result)) return undefined;
  const record = result as unknown as Record<string, unknown>;
  return typeof record.role === 'string' || typeof record.kind === 'string' || typeof record.conversationId === 'string'
    ? result as Message
    : undefined;
}

function productPrice(product?: Product): string {
  const sku = product?.sku ?? product?.skus?.[0];
  const raw = product?.price ?? sku?.price;
  const price = Number(raw);
  return Number.isFinite(price) ? `¥${price.toFixed(2)}` : '价格待同步';
}

function productInventory(product?: Product): string {
  const sku = product?.sku ?? product?.skus?.[0];
  const inventory = product?.inventory ?? sku?.inventory;
  return typeof inventory === 'number' ? `${inventory} 件` : '库存待同步';
}

export function productLearningPresentation(product: Product | undefined, shop: ShopSummary | undefined) {
  const status = product?.learning?.status ?? product?.learningSummary?.status;
  switch (status) {
    case 'SUCCEEDED':
      return { className: 'succeeded', label: '已完成' };
    case 'FAILED':
      return { className: 'failed', label: '失败' };
    case 'OUTDATED':
      return { className: 'outdated', label: '待更新' };
    case 'PENDING':
    case 'PROCESSING':
      return { className: 'pending', label: '准备中' };
    default:
      break;
  }

  switch (shop?.aiReadiness) {
    case 'READY':
      return { className: 'succeeded', label: '已完成' };
    case 'DEGRADED':
      return { className: 'partial_success', label: '部分失败' };
    case 'FAILED':
      return { className: 'failed', label: '失败' };
    case 'OFF':
      return { className: 'off', label: 'AI已关闭' };
    default:
      return { className: 'pending', label: '准备中' };
  }
}

function messageRole(message: Message): string {
  if (message.role === 'BUYER') return '买家';
  if (message.role === 'HUMAN') return '人工客服';
  if (message.role === 'SYSTEM') return '系统';
  return 'AI客服';
}

function MessageCard({ message, compact = false }: { message: Message; compact?: boolean }) {
  const removed = !isVisibleMessage(message);
  const isBuyer = message.role === 'BUYER';
  const product = message.product;
  const order = message.order;

  return (
    <article className={`live-message ${isBuyer ? 'is-buyer' : 'is-store'} ${message.role === 'SYSTEM' ? 'is-system' : ''} ${compact ? 'is-compact' : ''}`}>
      <div className="live-message-meta"><span>{messageRole(message)}</span><time>{readableTime(message.sentAt ?? message.createdAt)}</time>{message.status === 'EDITED' && <em>已编辑</em>}</div>
      <div className={`live-message-bubble ${removed ? 'is-removed' : ''}`}>
        {removed ? '此消息已从演示会话隐藏，审计记录仍保留。' : message.kind === 'GOODS_CARD' || message.kind === 'PRODUCT_CARD' ? (
          <div className="live-card-message"><Package aria-hidden="true" size={20} /><div><strong>{productLabel(product)}</strong><span>{productPrice(product)}</span></div></div>
        ) : message.kind === 'ORDER_CARD' ? (
          <div className="live-card-message"><ReceiptText aria-hidden="true" size={20} /><div><strong>{orderLabel(order)}</strong><span>{order?.status ?? '订单状态待同步'}</span></div></div>
        ) : messageText(message) || '（空消息）'}
      </div>
    </article>
  );
}

function EmptyLiveTest({ onOpenWorkbench }: { onOpenWorkbench?: () => void }) {
  return (
    <section className="live-test-empty" aria-labelledby="live-test-empty-title">
      <span><MessageSquareText aria-hidden="true" size={28} /></span>
      <h2 id="live-test-empty-title">添加店铺后开始实时联调</h2>
      <p>联调页只使用当前运营 Workspace 的真实店铺、买家、商品和消息管线。</p>
      {onOpenWorkbench && <button className="live-primary-button" type="button" onClick={onOpenWorkbench}>返回工作台添加店铺</button>}
    </section>
  );
}

export function LiveTestPage({
  token,
  shops,
  activeShopId,
  onShopChange,
  refreshKey,
  requestedShopId,
  realtimeEvent,
  socketStatus = 'idle',
  onOpenWorkbench,
}: LiveTestPageProps) {
  const requestedShop = requestedShopId ? shops.find((shop) => shop.id === requestedShopId) : undefined;
  const activeShop = shops.find((shop) => shop.id === activeShopId);
  const shop = requestedShop ?? activeShop ?? shops[0];
  const shopId = shop?.id ?? '';
  const [surface, setSurface] = useState<LiveTestSurface>('buyer');
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [buyerId, setBuyerId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [detail, setDetail] = useState<Conversation>();
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productPinned, setProductPinned] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [buyerComposer, setBuyerComposer] = useState('');
  const [storeComposer, setStoreComposer] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [messageOverrides, setMessageOverrides] = useState<Record<string, Message>>({});
  const [editingId, setEditingId] = useState('');
  const [editingText, setEditingText] = useState('');
  const [pendingRecallId, setPendingRecallId] = useState('');
  const requestGeneration = useRef(0);
  const buyerMessagesEndRef = useRef<HTMLDivElement>(null);
  const storeMessagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shopId && activeShopId !== shopId) onShopChange(shopId);
  }, [activeShopId, onShopChange, shopId]);

  const loadShop = useCallback(async () => {
    if (!shopId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setNotice(undefined);
    try {
      const [nextBuyers, nextProducts, nextConversations] = await Promise.all([
        getBuyers(token, shopId),
        getProducts(token, shopId),
        getConversations(token, shopId),
      ]);
      if (generation !== requestGeneration.current) return;
      setBuyers(nextBuyers);
      setProducts(nextProducts);
      setConversations(nextConversations);
      setBuyerId((current) => nextBuyers.some((buyer) => buyer.id === current) ? current : (nextBuyers[0]?.id ?? ''));
      setSelectedProductId((current) => nextProducts.some((product) => product.id === current) ? current : (nextProducts[0]?.id ?? ''));
    } catch (error) {
      if (generation === requestGeneration.current) setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [shopId, token]);

  useEffect(() => {
    setBuyerId('');
    setConversationId('');
    setDetail(undefined);
    setOrders([]);
    setOptimisticMessages([]);
    setMessageOverrides({});
    setProductPinned(false);
    void loadShop();
  }, [loadShop, refreshKey]);

  useEffect(() => {
    const matching = conversations.find((conversation) => conversation.buyerId === buyerId);
    setConversationId((current) => current && conversations.some((conversation) => conversation.id === current && conversation.buyerId === buyerId)
      ? current
      : (matching?.id ?? ''));
  }, [buyerId, conversations]);

  const refreshConversation = useCallback(async (targetId: string) => {
    if (!targetId) {
      setDetail(undefined);
      return;
    }
    try {
      const snapshot = await getConversation(token, targetId);
      setDetail(snapshot);
      setConversations((current) => current.some((conversation) => conversation.id === snapshot.id)
        ? current.map((conversation) => conversation.id === snapshot.id ? { ...conversation, ...snapshot } : conversation)
        : [snapshot, ...current]);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    }
  }, [token]);

  useEffect(() => {
    setDetail(undefined);
    if (conversationId) void refreshConversation(conversationId);
  }, [conversationId, refreshConversation]);

  useEffect(() => {
    if (!shopId || !buyerId) {
      setOrders([]);
      return;
    }
    let current = true;
    void getOrders(token, shopId, buyerId).then((nextOrders) => {
      if (!current) return;
      setOrders(nextOrders);
      setSelectedOrderId((selected) => nextOrders.some((order) => order.id === selected) ? selected : (nextOrders[0]?.id ?? ''));
    }).catch((error: unknown) => {
      if (current) setNotice({ text: errorMessage(error), tone: 'error' });
    });
    return () => { current = false; };
  }, [buyerId, refreshKey, shopId, token]);

  useEffect(() => {
    if (!realtimeEvent || !shopId || !shouldRefreshLiveTest(realtimeEvent, shopId, conversationId)) return;
    const targetId = eventConversationId(realtimeEvent) || conversationId;
    void Promise.all([getConversations(token, shopId), targetId ? getConversation(token, targetId) : Promise.resolve(undefined), getProducts(token, shopId)])
      .then(([nextConversations, nextDetail, nextProducts]) => {
        setConversations(nextConversations);
        setProducts(nextProducts);
        if (nextDetail) {
          setDetail(nextDetail);
          if (!conversationId && nextDetail.buyerId === buyerId) setConversationId(nextDetail.id);
        }
      })
      .catch((error: unknown) => setNotice({ text: errorMessage(error), tone: 'warning' }));
  }, [buyerId, conversationId, realtimeEvent, shopId, token]);

  const selectedConversation = detail?.id === conversationId
    ? detail
    : conversations.find((conversation) => conversation.id === conversationId);
  const selectedBuyer = buyers.find((buyer) => buyer.id === buyerId);
  const messages = useMemo(() => mergeLiveMessages(
    selectedConversation?.messages ?? [],
    optimisticMessages.filter((message) => !message.conversationId || !conversationId || message.conversationId === conversationId),
    messageOverrides,
  ), [conversationId, messageOverrides, optimisticMessages, selectedConversation?.messages]);
  const currentProduct = useMemo(() => resolveContextProduct(selectedConversation, messages, products, productPinned ? selectedProductId : undefined), [messages, productPinned, products, selectedConversation, selectedProductId]);
  const currentProductLearning = productLearningPresentation(currentProduct, shop);
  const pipeline = useMemo(() => derivePipelineStages(selectedConversation, messages), [messages, selectedConversation]);
  const filteredBuyers = useMemo(() => buyers.filter((buyer) => buyerLabel(buyer).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [buyers, search]);
  const currentDraft = selectedConversation?.currentDraft ?? selectedConversation?.activeReplyJob?.currentDraft ?? selectedConversation?.activeReplyJob?.draft;
  const storeCanSend = Boolean(conversationId && storeComposer.trim() && (selectedConversation?.humanActive || currentDraft?.status === 'WAITING_HUMAN'));

  useEffect(() => {
    buyerMessagesEndRef.current?.scrollIntoView({ block: 'nearest' });
    storeMessagesEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const appendOptimistic = (message: Message) => setOptimisticMessages((current) => [...current, message]);

  const reconcileAfterBuyerEvent = async (result: MutationResult, fallback: Message, successText: string) => {
    const received = mutationMessage(result);
    appendOptimistic({ ...fallback, ...(received ?? {}), id: received?.id ?? fallback.id });
    const nextConversationId = received?.conversationId || conversationId;
    if (nextConversationId) {
      setConversationId(nextConversationId);
      await refreshConversation(nextConversationId);
    } else {
      try {
        const nextConversations = await getConversations(token, shopId);
        setConversations(nextConversations);
        const created = nextConversations.find((conversation) => conversation.buyerId === buyerId);
        if (created) setConversationId(created.id);
      } catch {
        setNotice({ text: `${successText} 会话快照暂未返回，将通过实时连接继续同步。`, tone: 'warning' });
        return;
      }
    }
    setNotice({ text: successText, tone: 'success' });
  };

  const sendBuyerText = async () => {
    const text = buyerComposer.trim();
    if (!text || !shopId || !buyerId || busyAction) return;
    setBusyAction('buyer-text');
    setNotice(undefined);
    try {
      const result = await sendBuyerMessage(token, { shopId, buyerId, text, conversationId: conversationId || undefined });
      await reconcileAfterBuyerEvent(result, {
        id: `optimistic-${Date.now()}`,
        role: 'BUYER',
        kind: 'TEXT',
        status: 'ACTIVE',
        text,
        shopId,
        buyerId,
        conversationId,
        sentAt: new Date().toISOString(),
      }, '买家消息已发送，店铺端正在同步。');
      setBuyerComposer('');
      setSurface('store');
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  const sendProductCard = async () => {
    if (!currentProduct || !shopId || !buyerId || busyAction) return;
    setBusyAction('product-card');
    setNotice(undefined);
    try {
      const result = await sendBuyerProductCard(token, { shopId, buyerId, productId: currentProduct.id, conversationId: conversationId || undefined });
      await reconcileAfterBuyerEvent(result, {
        id: `optimistic-${Date.now()}`,
        role: 'BUYER',
        kind: 'GOODS_CARD',
        status: 'ACTIVE',
        productId: currentProduct.id,
        product: currentProduct,
        shopId,
        buyerId,
        conversationId,
        sentAt: new Date().toISOString(),
      }, '商品卡已发送，右侧商品上下文将使用同一快照。');
      setSurface('store');
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  const sendOrderCard = async () => {
    const order = orders.find((item) => item.id === selectedOrderId);
    if (!order || !shopId || !buyerId || busyAction) return;
    setBusyAction('order-card');
    setNotice(undefined);
    try {
      const result = await sendBuyerOrderCard(token, { shopId, buyerId, orderId: order.id, conversationId: conversationId || undefined });
      await reconcileAfterBuyerEvent(result, {
        id: `optimistic-${Date.now()}`,
        role: 'BUYER',
        kind: 'ORDER_CARD',
        status: 'ACTIVE',
        orderId: order.id,
        order,
        shopId,
        buyerId,
        conversationId,
        sentAt: new Date().toISOString(),
      }, '订单卡已发送，店铺端已收到订单上下文。');
      setSurface('store');
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  const saveBuyerEdit = async () => {
    const text = editingText.trim();
    if (!editingId || !text || busyAction) return;
    setBusyAction(`edit-${editingId}`);
    try {
      const result = await editBuyerMessage(token, editingId, text);
      const updated = mutationMessage(result);
      const base = messages.find((message) => message.id === editingId);
      if (base) setMessageOverrides((current) => ({ ...current, [editingId]: { ...base, ...(updated ?? {}), text, status: updated?.status ?? 'EDITED' } }));
      setEditingId('');
      setEditingText('');
      setNotice({ text: '消息已编辑；服务端会推进 Context version 并重新评估回复。', tone: 'success' });
      if (conversationId) await refreshConversation(conversationId);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  const recallBuyer = async () => {
    if (!pendingRecallId || busyAction) return;
    const messageId = pendingRecallId;
    setBusyAction(`recall-${messageId}`);
    try {
      const result = await recallBuyerMessage(token, messageId);
      const updated = mutationMessage(result);
      const base = messages.find((message) => message.id === messageId);
      if (base) setMessageOverrides((current) => ({ ...current, [messageId]: { ...base, ...(updated ?? {}), status: updated?.status ?? 'RECALLED' } }));
      setNotice({ text: '消息已从演示会话隐藏；审计记录仍保留。', tone: 'warning' });
      if (conversationId) await refreshConversation(conversationId);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setPendingRecallId('');
      setBusyAction('');
    }
  };

  const toggleHumanTakeover = async () => {
    if (!selectedConversation || busyAction) return;
    setBusyAction('takeover');
    try {
      if (selectedConversation.humanActive) {
        await resumeConversationAi(token, selectedConversation.id, shopId);
        setNotice({ text: '已交还 AI，后续回复仍受店铺策略和安全门禁约束。', tone: 'success' });
      } else {
        await takeoverConversation(token, selectedConversation.id, shopId);
        setNotice({ text: '人工接管已开启，可以从店铺端直接回复。', tone: 'success' });
      }
      await refreshConversation(selectedConversation.id);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  const sendStoreReply = async () => {
    const text = storeComposer.trim();
    if (!storeCanSend || !selectedConversation || busyAction) return;
    setBusyAction('store-reply');
    try {
      await sendConversationMessage(token, selectedConversation.id, shopId, selectedConversation.humanActive
        ? { text }
        : { text, sourceDraftId: currentDraft?.id, editType: 'STYLE_EDIT' });
      setStoreComposer('');
      setNotice({ text: '店铺回复已进入 Outbox，等待发送回执。', tone: 'success' });
      await refreshConversation(selectedConversation.id);
    } catch (error) {
      setNotice({ text: errorMessage(error), tone: 'error' });
    } finally {
      setBusyAction('');
    }
  };

  if (!shop) return <EmptyLiveTest onOpenWorkbench={onOpenWorkbench ? () => onOpenWorkbench('') : undefined} />;

  return (
    <section className="live-test-page" aria-labelledby="live-test-title">
      <ConfirmDialog
        busy={busyAction === `recall-${pendingRecallId}`}
        confirmLabel="确认隐藏"
        description="该操作会从演示会话隐藏消息并保留审计记录，不代表真实电商平台撤回。"
        onCancel={() => setPendingRecallId('')}
        onConfirm={() => void recallBuyer()}
        open={Boolean(pendingRecallId)}
        title="撤回这条买家消息？"
      />

      <header className="live-test-header">
        <div>
          <span className="live-eyebrow">REAL-TIME INTEGRATION</span>
          <h1 id="live-test-title">实时联调</h1>
          <p>买家端与店铺端共享同一 Workspace、同一会话和同一服务端事实。</p>
        </div>
        <div className="live-test-header-actions">
          <label className="live-shop-select"><span>联调店铺</span><select aria-label="选择联调店铺" value={shopId} onChange={(event) => onShopChange(event.currentTarget.value)}>{shops.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <span className={`live-connection is-${socketStatus}`} aria-label={`实时连接：${socketStatus === 'connected' ? '已连接' : socketStatus === 'connecting' ? '连接中' : '等待连接'}`}>
            {socketStatus === 'connected' ? <Wifi aria-hidden="true" size={15} /> : <WifiOff aria-hidden="true" size={15} />}
            {socketStatus === 'connected' ? '实时已连接' : socketStatus === 'connecting' ? '正在连接' : '等待重连'}
          </span>
          <button className="live-icon-button" type="button" onClick={() => void loadShop()} disabled={loading} aria-label="刷新联调快照" title="刷新联调快照"><RefreshCw aria-hidden="true" className={loading ? 'is-spinning' : ''} size={17} /></button>
          {onOpenWorkbench && <button className="live-secondary-button" type="button" onClick={() => onOpenWorkbench(shopId)}><Monitor aria-hidden="true" size={16} />打开工作台</button>}
        </div>
      </header>

      <nav className="live-mobile-tabs" aria-label="联调视图" role="tablist">
        <button aria-selected={surface === 'buyer'} onClick={() => setSurface('buyer')} role="tab" type="button"><Smartphone aria-hidden="true" size={16} />买家端</button>
        <button aria-selected={surface === 'store'} onClick={() => setSurface('store')} role="tab" type="button"><Store aria-hidden="true" size={16} />店铺端</button>
      </nav>

      <section className="live-pipeline" aria-label="本轮消息处理状态">
        {pipeline.map((stage, index) => <div className={`live-pipeline-stage is-${stage.state}`} key={stage.key}><span>{stage.state === 'done' ? <Check aria-hidden="true" size={14} /> : stage.state === 'active' ? <Clock3 aria-hidden="true" size={14} /> : stage.state === 'attention' ? '!' : index + 1}</span><div><strong>{stage.label}</strong><small>{stage.description}</small></div></div>)}
      </section>

      <div className="live-test-layout">
        <section className={`live-buyer-pane ${surface === 'buyer' ? 'is-mobile-active' : ''}`} aria-label="买家端">
          <div className="live-pane-heading"><div><Smartphone aria-hidden="true" size={18} /><span><strong>买家端</strong><small>MockDouyin 演示消费者</small></span></div><span className="live-pane-badge">真实 API</span></div>
          <div className="live-phone">
            <div className="live-phone-top"><span>09:41</span><span>● ● ▰</span></div>
            <header><span aria-hidden="true" className="live-avatar">{buyerLabel(selectedBuyer).slice(0, 1)}</span><div><strong>{shop.name}</strong><small><i /> 在线 · 智能客服</small></div></header>
            <label className="live-buyer-picker"><span>当前买家</span><select aria-label="选择模拟买家" value={buyerId} onChange={(event) => setBuyerId(event.currentTarget.value)}>{buyers.length === 0 ? <option value="">暂无买家</option> : buyers.map((buyer) => <option key={buyer.id} value={buyer.id}>{buyerLabel(buyer)}</option>)}</select></label>
            <div className="live-phone-messages" aria-live="polite">
              {loading ? <div className="live-chat-empty"><RefreshCw aria-hidden="true" className="is-spinning" size={22} /><strong>正在同步会话</strong></div> : messages.length === 0 ? <div className="live-chat-empty"><MessageSquareText aria-hidden="true" size={26} /><strong>开始一次真实咨询</strong><small>发送后可在右侧观察接收、AI处理和回执。</small></div> : messages.map((message) => (
                <div className="live-buyer-message-wrap" key={message.id}>
                  <MessageCard compact message={message} />
                  {message.role === 'BUYER' && isVisibleMessage(message) && !message.id.startsWith('optimistic-') && <div className="live-buyer-message-actions"><button type="button" onClick={() => { setEditingId(message.id); setEditingText(messageText(message)); }}><Edit3 aria-hidden="true" size={12} />编辑</button><button type="button" onClick={() => setPendingRecallId(message.id)}><RotateCcw aria-hidden="true" size={12} />撤回/隐藏</button></div>}
                  {editingId === message.id && <div className="live-inline-editor"><label><span className="live-sr-only">编辑消息</span><textarea aria-label="编辑买家消息" rows={2} value={editingText} onChange={(event) => setEditingText(event.currentTarget.value)} /></label><div><button type="button" onClick={() => setEditingId('')}>取消</button><button type="button" onClick={() => void saveBuyerEdit()} disabled={!editingText.trim() || Boolean(busyAction)}>保存</button></div></div>}
                </div>
              ))}
              <div ref={buyerMessagesEndRef} />
            </div>
            <div className="live-phone-events">
              <label><Package aria-hidden="true" size={14} /><select aria-label="选择要发送的商品" value={currentProduct?.id ?? selectedProductId} onChange={(event) => { setSelectedProductId(event.currentTarget.value); setProductPinned(true); }}><option value="">暂无商品</option>{products.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}</select><button type="button" onClick={() => void sendProductCard()} disabled={!currentProduct || !buyerId || Boolean(busyAction)}>发商品卡</button></label>
              <label><ReceiptText aria-hidden="true" size={14} /><select aria-label="选择要发送的订单" value={selectedOrderId} onChange={(event) => setSelectedOrderId(event.currentTarget.value)}><option value="">暂无订单</option>{orders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}</select><button type="button" onClick={() => void sendOrderCard()} disabled={!selectedOrderId || !buyerId || Boolean(busyAction)}>发订单卡</button></label>
            </div>
            <div className="live-phone-composer"><textarea aria-label="买家消息" placeholder="输入咨询内容…" rows={1} value={buyerComposer} onChange={(event) => setBuyerComposer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendBuyerText(); } }} /><button aria-label="发送买家消息" type="button" onClick={() => void sendBuyerText()} disabled={!buyerComposer.trim() || !buyerId || Boolean(busyAction)}><Send aria-hidden="true" size={17} /></button></div>
          </div>
        </section>

        <section className={`live-store-pane ${surface === 'store' ? 'is-mobile-active' : ''}`} aria-label="店铺端">
          <div className="live-pane-heading"><div><Store aria-hidden="true" size={18} /><span><strong>店铺端</strong><small>{shop.name} · 同一服务端快照</small></span></div><span className={`live-pane-badge ${selectedConversation ? 'is-ready' : ''}`}>{selectedConversation ? '已收到会话' : '等待事件'}</span></div>
          <div className="live-store-grid">
            <aside className="live-contacts" aria-label="联系人">
              <div className="live-contacts-title"><span><strong>联系人</strong><small>{conversations.length} 个会话</small></span><MessageSquareText aria-hidden="true" size={17} /></div>
              <label className="live-search"><Search aria-hidden="true" size={15} /><span className="live-sr-only">搜索联系人</span><input aria-label="搜索联系人" placeholder="搜索买家" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></label>
              <div className="live-contact-list">
                {filteredBuyers.length === 0 ? <p className="live-list-empty">暂无联系人</p> : filteredBuyers.map((buyer) => {
                  const conversation = conversations.find((item) => item.buyerId === buyer.id);
                  const preview = conversation?.lastMessage ? messageText(conversation.lastMessage) || (conversation.lastMessage.kind === 'ORDER_CARD' ? '[订单卡]' : '[商品卡]') : '尚未开始咨询';
                  return <button className={buyer.id === buyerId ? 'is-active' : ''} key={buyer.id} type="button" onClick={() => setBuyerId(buyer.id)}><span className="live-avatar">{buyerLabel(buyer).slice(0, 1)}</span><span><strong>{buyerLabel(buyer)}</strong><small>{preview}</small></span>{(conversation?.unreadCount ?? 0) > 0 && <b>{conversation?.unreadCount}</b>}</button>;
                })}
              </div>
            </aside>

            <section className="live-store-chat" aria-label="店铺聊天">
              <header><div><span className="live-avatar is-store-avatar"><UserRound aria-hidden="true" size={15} /></span><span><strong>{buyerLabel(selectedBuyer)}</strong><small>{selectedConversation ? `会话 ${selectedConversation.id.slice(0, 8)} · ${selectedConversation.effectiveMode ?? selectedConversation.mode ?? '策略继承店铺'}` : '等待买家发送第一条消息'}</small></span></div>{selectedConversation && <button className={selectedConversation.humanActive ? 'is-human-active' : ''} type="button" onClick={() => void toggleHumanTakeover()} disabled={busyAction === 'takeover'}>{selectedConversation.humanActive ? '交还 AI' : '人工接管'}</button>}</header>
              <div className="live-store-messages" aria-live="polite">
                {messages.length === 0 ? <div className="live-chat-empty"><Bot aria-hidden="true" size={28} /><strong>等待买家消息</strong><small>买家端发送后，这里会通过 WebSocket 与 REST 快照自动同步。</small></div> : messages.map((message) => <MessageCard key={message.id} message={message} />)}
                {currentDraft && isVisibleMessage({ id: currentDraft.id, status: currentDraft.status } as Message) && currentDraft.status !== 'SENT' && <article className="live-draft-card"><div><Bot aria-hidden="true" size={16} /><strong>AI草稿</strong><span>{currentDraft.status}</span></div><p>{currentDraft.humanFinal ?? currentDraft.aiDraft}</p></article>}
                <div ref={storeMessagesEndRef} />
              </div>
              <div className="live-store-composer"><textarea aria-label="店铺回复" placeholder={selectedConversation?.humanActive ? '输入人工回复…' : currentDraft ? '编辑并发送当前草稿…' : '人工接管后可直接回复'} rows={2} value={storeComposer} onChange={(event) => setStoreComposer(event.currentTarget.value)} /><button type="button" onClick={() => void sendStoreReply()} disabled={!storeCanSend || Boolean(busyAction)}><Send aria-hidden="true" size={15} />发送回复</button>{!selectedConversation?.humanActive && !currentDraft && <small>当前没有可发送草稿；可先人工接管。</small>}</div>
            </section>

            <aside className="live-product-pane" aria-label="商品上下文">
              <div className="live-product-heading"><span><Package aria-hidden="true" size={17} /><strong>商品信息</strong></span><b>{products.length}</b></div>
              <label className="live-product-select"><span>查看商品</span><select aria-label="切换商品详情" value={currentProduct?.id ?? ''} onChange={(event) => { setSelectedProductId(event.currentTarget.value); setProductPinned(true); }}><option value="">暂无商品</option>{products.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}</select></label>
              {currentProduct ? <article className="live-product-card"><div className="live-product-art"><Package aria-hidden="true" size={28} /></div><strong>{productLabel(currentProduct)}</strong><p>{currentProduct.description ?? '该商品暂无补充描述。'}</p><dl><div><dt>价格</dt><dd>{productPrice(currentProduct)}</dd></div><div><dt>库存</dt><dd>{productInventory(currentProduct)}</dd></div><div><dt>状态</dt><dd>{currentProduct.status ?? '待同步'}</dd></div><div><dt>商品学习</dt><dd className={`is-learning-${currentProductLearning.className}`}>{currentProductLearning.label}</dd></div></dl></article> : <p className="live-list-empty">暂无商品数据</p>}
              <section className="live-receipt-card"><span><CheckCircle2 aria-hidden="true" size={17} /><strong>本轮状态</strong></span>{pipeline.map((stage) => <div key={stage.key}><span className={`is-${stage.state}`}>{stage.state === 'done' ? <Check aria-hidden="true" size={11} /> : stage.state === 'active' ? <Clock3 aria-hidden="true" size={11} /> : <Circle aria-hidden="true" size={9} />}</span><p><strong>{stage.label}</strong><small>{stage.description}</small></p></div>)}</section>
            </aside>
          </div>
        </section>
      </div>

      <div className={`live-notice ${notice ? `is-${notice.tone}` : ''}`} aria-live="polite" role="status">{notice?.text ?? '提示：左侧每次操作只调用一次真实 API，右侧由同一 Workspace 快照同步。'}</div>
    </section>
  );
}
