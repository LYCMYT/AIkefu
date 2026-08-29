import type { Conversation } from '../../api';
import { buyerName } from '../shared/view-models';

export type ConversationFilter = 'all' | 'unread' | 'taken_over';

export type ConversationAiDisplayState = '生成中' | '已自动发送' | '已停止' | '需要人工';

type ShopAiContext = {
  aiMode?: string;
  aiReadiness?: string;
  settingsConfirmed?: boolean;
};

export function conversationAiState(conversation: {
  humanActive?: boolean;
  currentDraft?: { status?: string } | null;
  sendOutbox?: { status?: string } | null;
  effectiveMode?: string;
  mode?: string;
}): ConversationAiDisplayState {
  if (conversation.humanActive || conversation.effectiveMode === 'MANUAL' || conversation.mode === 'MANUAL') return '已停止';
  if (conversation.currentDraft?.status === 'GENERATING') return '生成中';
  if (conversation.currentDraft?.status === 'WAITING_HUMAN' || conversation.currentDraft?.status === 'FAILED' || conversation.currentDraft?.status === 'STALE' || conversation.currentDraft?.status === 'EXPIRED') return '需要人工';
  if (conversation.sendOutbox?.status === 'SENT' || conversation.sendOutbox?.status === 'DELIVERED') return '已自动发送';
  return '需要人工';
}

export function conversationAiExplanation(conversation: {
  humanActive?: boolean;
  currentDraft?: { status?: string } | null;
  sendOutbox?: { status?: string; failureCode?: string | null } | null;
  activeReplyJob?: { status?: string; staleReason?: string | null; needsReplanReason?: string | null; mode?: string } | null;
  effectiveMode?: string;
  mode?: string;
}, shop?: ShopAiContext): string {
  if (shop?.aiMode === 'MANUAL_ONLY' || shop?.aiReadiness === 'OFF') return '店铺 AI 已关闭，新消息仅由人工处理';
  if (shop?.settingsConfirmed === false) return '请先确认基础设置，完成后 AI 才能自动回复';
  if (shop?.aiReadiness === 'PREPARING') return '商品知识正在准备，当前消息不会自动发送';
  if (shop?.aiReadiness === 'DEGRADED') return '部分商品学习失败，自动回复已阻断，请处理后重试';
  if (shop?.aiReadiness === 'FAILED') return '商品学习失败，自动回复已阻断';
  if (conversation.humanActive) return '人工已接管，AI 不会发送本轮回复';
  if (conversation.sendOutbox?.status === 'FAILED') return '回复未发送成功，请查看错误治理或由人工回复';
  if (conversation.sendOutbox?.status === 'UNCERTAIN') return '外发结果不确定，系统已停止自动重试';
  if (conversation.currentDraft?.status === 'WAITING_HUMAN' || conversation.activeReplyJob?.status === 'WAITING_HUMAN' || conversation.effectiveMode === 'ASSIST') {
    return 'AI 已开启，本轮因风险或证据不足需要人工确认';
  }
  if (conversation.currentDraft?.status === 'GENERATING' || conversation.activeReplyJob?.status === 'GENERATING') return 'AI 正在为本轮生成回复';
  if (conversation.sendOutbox?.status === 'SENT') return '本轮回复已发送并写入会话';
  return 'AI 已开启，每轮仍会根据风险与证据自动降级';
}

export function filterConversations(conversations: Conversation[], query: string, filter: ConversationFilter): Conversation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  return conversations.filter((conversation) => {
    if (filter === 'unread' && (conversation.unreadCount ?? 0) === 0) return false;
    if (filter === 'taken_over' && !conversation.humanActive) return false;
    if (!normalizedQuery) return true;
    const message = typeof conversation.lastMessage?.text === 'string' ? conversation.lastMessage.text : '';
    return `${buyerName(conversation.buyer)} ${conversation.externalConversationId ?? ''} ${message}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery);
  });
}
