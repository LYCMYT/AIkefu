import { messageText, type Conversation, type Message, type Product, type ReplyDraft, type ReplyJob, type SendOutbox } from '../../api';

export type LiveTestSurface = 'buyer' | 'store';
export type PipelineStageState = 'idle' | 'active' | 'done' | 'attention';

export interface PipelineStage {
  key: 'sent' | 'received' | 'draft' | 'reply' | 'receipt';
  label: string;
  description: string;
  state: PipelineStageState;
}

export interface CurrentTurnLifecycle {
  buyerMessage?: Message;
  job?: ReplyJob;
  draft?: ReplyDraft;
  outbox?: SendOutbox;
  response?: Message;
}

export function liveTestRefreshKind(previousScope: string, token: string, shopId: string): 'initialize' | 'background' {
  return previousScope === `${token}:${shopId}` ? 'background' : 'initialize';
}

const removedStatuses = new Set(['RECALLED', 'DELETED']);
const replyRoles = new Set(['ASSISTANT', 'AI', 'HUMAN']);

export function isVisibleMessage(message: Message): boolean {
  return !removedStatuses.has(message.status ?? '');
}

export function messageTimestamp(message: Message): number {
  const timestamp = message.sentAt ?? message.receivedAt ?? message.createdAt;
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Merge server snapshots, optimistic sends, and edit/recall overlays without duplicating a message. */
export function mergeLiveMessages(
  serverMessages: Message[],
  optimisticMessages: Message[],
  overrides: Readonly<Record<string, Message>>,
): Message[] {
  const byId = new Map<string, Message>();
  [...serverMessages, ...optimisticMessages].forEach((message) => {
    const previous = byId.get(message.id);
    byId.set(message.id, { ...previous, ...message, ...(overrides[message.id] ?? {}) });
  });
  Object.values(overrides).forEach((message) => {
    const previous = byId.get(message.id);
    byId.set(message.id, { ...previous, ...message });
  });
  return Array.from(byId.values()).sort((left, right) => {
    const sequenceDelta = (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
    if (sequenceDelta !== 0) return sequenceDelta;
    return messageTimestamp(left) - messageTimestamp(right);
  });
}

export function latestVisibleMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(isVisibleMessage);
}

export function conversationPreview(conversation: Conversation): string {
  const last = conversation.lastMessage ?? latestVisibleMessage(conversation.messages ?? []);
  if (!last) return '尚未开始咨询';
  if (last.status === 'RECALLED' || last.status === 'DELETED') return '消息已撤回';
  if (last.kind === 'GOODS_CARD' || last.kind === 'PRODUCT_CARD') return '[商品卡]';
  if (last.kind === 'ORDER_CARD') return '[订单卡]';
  return messageText(last) || '[消息]';
}

export function resolveContextProduct(
  conversation: Conversation | undefined,
  messages: Message[],
  products: Product[],
  selectedProductId?: string,
): Product | undefined {
  const explicit = selectedProductId ? products.find((product) => product.id === selectedProductId) : undefined;
  if (explicit) return explicit;

  const latestProductMessage = [...messages].reverse().find((message) =>
    isVisibleMessage(message) && (message.kind === 'GOODS_CARD' || message.kind === 'PRODUCT_CARD'),
  );
  const productId = latestProductMessage?.productId
    ?? latestProductMessage?.product?.id
    ?? conversation?.currentProductId;
  return products.find((product) => product.id === productId) ?? latestProductMessage?.product ?? products[0];
}

export function deriveCurrentTurnLifecycle(conversation: Conversation | undefined, messages: Message[]): CurrentTurnLifecycle {
  const buyerMessage = [...messages].reverse().find((message) => message.role === 'BUYER' && isVisibleMessage(message));
  const turn = buyerMessage ? conversation?.userTurns?.find((item) => item.sourceMessageIds.includes(buyerMessage.id)) : undefined;
  const candidateJob = conversation?.activeReplyJob;
  const job = buyerMessage && candidateJob && (
    (turn?.id && candidateJob.userTurnId === turn.id)
    || candidateJob.sourceLastMessageId === buyerMessage.id
    || (buyerMessage.sequence !== undefined && candidateJob.sourceSequence === buyerMessage.sequence)
  ) ? candidateJob : undefined;
  const candidateDraft = job?.currentDraft ?? job?.draft ?? conversation?.currentDraft;
  const draft = buyerMessage && candidateDraft && (
    candidateDraft.replyJobId === job?.id
    || candidateDraft.sourceLastMessageId === buyerMessage.id
    || (buyerMessage.sequence !== undefined && candidateDraft.sourceSequence === buyerMessage.sequence)
  ) ? candidateDraft : undefined;
  const candidateOutbox = job?.sendOutbox ?? conversation?.sendOutbox;
  const senderRole = candidateOutbox?.payload && typeof candidateOutbox.payload === 'object'
    ? (candidateOutbox.payload as Record<string, unknown>).senderRole
    : undefined;
  const buyerSequence = buyerMessage?.sequence;
  const replyMessagesAfterBuyer = buyerMessage
    && conversation?.id === buyerMessage.conversationId
    && isCommittedSequence(buyerSequence)
    ? [...messages].reverse().filter((message) =>
        replyRoles.has(message.role ?? '')
        && isVisibleMessage(message)
        && message.conversationId === buyerMessage.conversationId
        && isCommittedSequence(message.sequence)
        && message.sequence > buyerSequence,
      )
    : [];
  const receiptExternalMessageId = candidateOutbox?.receipt?.externalMessageId;
  const receiptResponse = candidateOutbox?.status === 'SENT'
    ? replyMessagesAfterBuyer.find((message) => Boolean(message.externalMessageId) && (
        message.externalMessageId === candidateOutbox.id
        || message.externalMessageId === receiptExternalMessageId
      ))
    : undefined;
  const outbox = buyerMessage && candidateOutbox && (
    (job?.id && candidateOutbox.replyJobId === job.id)
    || Boolean(receiptResponse)
    || (candidateOutbox.status !== 'SENT' && senderRole === 'HUMAN' && (
      candidateOutbox.expectedLastMessageId === buyerMessage.id
      || (buyerMessage.sequence !== undefined && candidateOutbox.expectedSequence === buyerMessage.sequence)
    ))
    || (candidateOutbox.status !== 'SENT' && candidateOutbox.replyJobId && (
      candidateOutbox.expectedLastMessageId === buyerMessage.id
      || (buyerMessage.sequence !== undefined && candidateOutbox.expectedSequence === buyerMessage.sequence)
    ))
  ) ? candidateOutbox : undefined;
  const responseCandidate = replyMessagesAfterBuyer[0];
  const response = receiptResponse ?? (responseCandidate && draft?.status === 'SENT' ? responseCandidate : undefined);
  return { buyerMessage, job, draft, outbox, response };
}

function isCommittedSequence(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0;
}

export function derivePipelineStages(conversation: Conversation | undefined, messages: Message[]): PipelineStage[] {
  const { buyerMessage, job, draft, outbox, response } = deriveCurrentTurnLifecycle(conversation, messages);
  const received = Boolean(conversation?.id && buyerMessage);
  const jobStatus = job?.status;

  const draftState: PipelineStageState = response
    ? 'done'
    : draft
    ? ['STALE', 'EXPIRED', 'FAILED', 'CANCELLED'].includes(draft.status) ? 'attention' : 'done'
    : jobStatus
      ? ['WAITING_HUMAN', 'FAILED', 'STALE', 'EXPIRED', 'CANCELLED'].includes(jobStatus) ? 'attention' : 'active'
      : received && !response ? 'active' : 'idle';

  const replyState: PipelineStageState = response
    ? 'done'
    : draft || jobStatus === 'WAITING_HUMAN'
      ? 'attention'
      : jobStatus
        ? 'active'
        : 'idle';

  const receiptState: PipelineStageState = outbox
    ? outbox.status === 'SENT'
      ? 'done'
      : ['FAILED', 'UNCERTAIN', 'CANCELLED'].includes(outbox.status)
        ? 'attention'
        : 'active'
    : response
      ? 'done'
      : 'idle';

  return [
    { key: 'sent', label: '买家已发送', description: buyerMessage ? '事件已写入消息管线' : '等待买家发送事件', state: buyerMessage ? 'done' : 'idle' },
    { key: 'received', label: '店铺已收到', description: received ? '同一会话已同步' : '等待服务端创建会话', state: received ? 'done' : buyerMessage ? 'active' : 'idle' },
    { key: 'draft', label: 'AI处理', description: response ? '本轮回复已完成' : draft ? '回复草稿已生成' : jobStatus ? `当前轮次：${readableJobStatus(jobStatus)}` : received ? '等待当前轮次回复任务' : '等待回复任务', state: draftState },
    { key: 'reply', label: '回复完成', description: response ? '店铺回复已进入时间线' : draft?.status === 'WAITING_HUMAN' || jobStatus === 'WAITING_HUMAN' ? '需要人工确认' : '等待自动或人工回复', state: replyState },
    { key: 'receipt', label: '发送回执', description: outbox ? `Outbox：${outbox.status}` : response ? '回复已持久化' : '等待外发结果', state: receiptState },
  ];
}

function readableJobStatus(status: string): string {
  if (status === 'PENDING') return '等待处理';
  if (status === 'GENERATING') return '生成回复';
  if (status === 'FAST_PATH_READY') return '回复已就绪';
  if (status === 'WAITING_HUMAN') return '等待人工确认';
  if (['STALE', 'EXPIRED', 'CANCELLED'].includes(status)) return '已停止';
  if (status === 'FAILED') return '处理失败';
  return '处理中';
}

export function eventType(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const value = (event as Record<string, unknown>).eventType;
  return typeof value === 'string' ? value : '';
}

export function eventConversationId(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const record = event as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : undefined;
  if (typeof payload?.conversationId === 'string') return payload.conversationId;
  if (payload?.conversation && typeof payload.conversation === 'object') {
    const id = (payload.conversation as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  return record.entityType === 'CONVERSATION' && typeof record.entityId === 'string' ? record.entityId : '';
}

export function eventShopId(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const record = event as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : undefined;
  if (typeof payload?.shopId === 'string') return payload.shopId;
  if (payload?.conversation && typeof payload.conversation === 'object') {
    const id = (payload.conversation as Record<string, unknown>).shopId;
    if (typeof id === 'string') return id;
  }
  return '';
}

const liveEventTypes = new Set([
  'CONVERSATION_UPDATED',
  'MESSAGE_RECEIVED',
  'MESSAGE_EDITED',
  'MESSAGE_RECALLED',
  'USER_TURN_CREATED',
  'REPLY_JOB_STARTED',
  'REPLY_JOB_STREAM',
  'REPLY_JOB_WAITING_HUMAN',
  'REPLY_JOB_STALE',
  'REPLY_JOB_EXPIRED',
  'REPLY_SENT',
  'ORDER_UPDATED',
  'PRODUCT_UPDATED',
  'PRODUCT_LEARNING_UPDATED',
]);

export function shouldRefreshLiveTest(event: unknown, shopId: string, conversationId = ''): boolean {
  if (!liveEventTypes.has(eventType(event))) return false;
  const scopedShop = eventShopId(event);
  if (scopedShop && scopedShop !== shopId) return false;
  const scopedConversation = eventConversationId(event);
  return !scopedConversation || !conversationId || scopedConversation === conversationId;
}

export interface LiveTestRealtimeRefreshPlan {
  conversationId?: string;
  conversations?: true;
  products?: true;
  orders?: true;
}

/** Convert one pushed event into the smallest canonical REST reconciliation. */
export function liveTestRealtimeRefreshPlan(event: unknown, selectedConversationId = ''): LiveTestRealtimeRefreshPlan {
  const type = eventType(event);
  if (type === 'PRODUCT_UPDATED' || type === 'PRODUCT_LEARNING_UPDATED') return { products: true };
  if (type === 'ORDER_UPDATED') return { orders: true };
  const conversationId = eventConversationId(event) || selectedConversationId;
  return conversationId ? { conversationId } : { conversations: true };
}
