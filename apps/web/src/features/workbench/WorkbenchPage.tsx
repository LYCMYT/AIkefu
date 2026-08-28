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
  deleteConversationMessage,
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
  updateShopAiMode,
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
import { buyerTextSubmissionEnabled, canSoftRemoveMessage, humanFinalSubmission } from '../../workbench-actions';
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


import * as viewModel from '../shared/view-models';
const { defaultNavigationItem, readableTime, readableDate, shortId, buyerName, productName, orderName, statusLabel, errorMessage, modeLabel, connectionStateLabel, localDayKey, conversationTimestamp, metric, buildAdminOverviewSnapshot, buildConversationTrend, isConversationModeAllowed, conversationModeOptionLabel, draftStatusLabel, draftRemainingLabel, taskStatusLabel, tagsFromBuyer, firstSku, productPrice, productInventory, objectValue, redactTraceValue, redactDeveloperTracePayload, shouldLoadDeveloperTrace, traceRequestedBySearch, visibleDeveloperTraceEvents, isMessage, cardData, messageKindLabel, messageRoleLabel, messageSort, knowledgeScopeLabel, knowledgeSourceLabel, knowledgeBusinessLabel, knowledgeIndexLabel, knowledgeVersion, knowledgeStatusClass, learningStatusLabel, learningStatusClass, learningProgress, eventHasWorkspaceShape, isPhase03SnapshotEvent } = viewModel;
type FoundationState = viewModel.FoundationState;
type SharedViewProps = viewModel.SharedViewProps;
type AdminMetricSnapshot = viewModel.AdminMetricSnapshot;
type AdminOverviewSnapshot = viewModel.AdminOverviewSnapshot;
type ConversationTrendPoint = viewModel.ConversationTrendPoint;
type WorkbenchConversationMode = viewModel.WorkbenchConversationMode;

import { Avatar, MessageBubble, ContextProduct, ContextOrder, DeveloperTracePanel } from '../workbench/components';
import { ConfirmDialog, SegmentedTabs } from '../../components/ui/primitives';
import { filterConversations, type ConversationFilter } from './workbench-model';


export function WorkbenchPage({ token, shops, activeShopId, onShopChange, refreshKey, realtimeEvent, traceOpen = false, onTraceClose = () => undefined, onFoundationRefresh }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<Conversation>();
  const [detail, setDetail] = useState<Conversation>();
  const [query, setQuery] = useState('');
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>('all');
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
  const [pendingMemoryDelete, setPendingMemoryDelete] = useState<CustomerMemory>();
  const [pendingMessageRemoval, setPendingMessageRemoval] = useState<Message>();
  const [messageAction, setMessageAction] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [pendingAutoEnable, setPendingAutoEnable] = useState(false);
  const [developerTrace, setDeveloperTrace] = useState<DeveloperTrace>();
  const [developerTraceLoading, setDeveloperTraceLoading] = useState(false);
  const [developerTraceError, setDeveloperTraceError] = useState('');
  const queryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusConversationSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if (event.key !== '/' || isEditing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      queryInputRef.current?.focus();
    };
    window.addEventListener('keydown', focusConversationSearch);
    return () => window.removeEventListener('keydown', focusConversationSearch);
  }, []);

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
  const visibleConversations = useMemo(() => filterConversations(conversations, query, conversationFilter), [conversationFilter, conversations, query]);
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
  const selectedMode = activeConversation?.overrideMode ?? activeConversation?.mode ?? effectiveMode;
  const taskBundle = activeConversation?.taskBundle;
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
    setActionNotice('');
    try {
      await setConversationMode(token, selectedConversationId, shopId, mode);
      await refreshConversationSnapshot();
      setActionNotice(`会话策略已切换为 ${mode}。风险规则仍会对当前有效模式进行降级。`);
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setConversationAction('');
    }
  };

  const enableShopAuto = async () => {
    if (!selectedConversationId || !activeShop) return;
    setConversationAction('enable-auto');
    setSendError('');
    setActionNotice('');
    try {
      await updateShopAiMode(token, activeShop.id, 'AUTO_ALLOWED');
      try {
        await setConversationMode(token, selectedConversationId, shopId, 'AUTO');
        await Promise.all([refreshConversationSnapshot(), onFoundationRefresh?.() ?? Promise.resolve()]);
        setActionNotice('已开启整店 AUTO，并将当前会话设为 AUTO；仅影响后续新任务，高风险消息仍会转人工。');
      } catch (error) {
        await onFoundationRefresh?.();
        setActionNotice(`整店 AUTO 已开启，但当前会话未能切换，请在会话策略中重试：${errorMessage(error)}`);
      }
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setConversationAction('');
      setPendingAutoEnable(false);
    }
  };

  const removeMessage = async (message: Message) => {
    if (!selectedConversationId || !canSoftRemoveMessage(message)) return;
    setMessageAction(`remove-${message.id}`);
    setSendError('');
    setActionNotice('');
    try {
      const updated = message.role === 'BUYER'
        ? await recallBuyerMessage(token, message.id)
        : await deleteConversationMessage(token, selectedConversationId, message.id, shopId);
      const next: Message = {
        ...message,
        ...(isMessage(updated) ? updated : {}),
        status: 'RECALLED',
      };
      setLocalMessages((current) => current.some((item) => item.id === message.id)
        ? current.map((item) => item.id === message.id ? next : item)
        : [...current, next]);
      setActionNotice('消息已从本演示会话隐藏；审计记录仍保留，不代表抖音平台已撤回。');
      await refreshConversationSnapshot();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setMessageAction('');
      setPendingMessageRemoval(undefined);
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
      setPendingMemoryDelete(undefined);
    }
  };

  const contextProductList = activeProduct ? [activeProduct, ...products.filter((product) => product.id !== activeProduct.id).slice(0, 2)] : products.slice(0, 3);

  return (
    <div className="workbench-layout">
      {pendingMemoryDelete && <ConfirmDialog busy={memoryAction === `delete-${pendingMemoryDelete.id}`} confirmLabel="确认删除" description={`记忆“${pendingMemoryDelete.key}”将从当前店铺与买家的人工记忆中删除。`} onCancel={() => setPendingMemoryDelete(undefined)} onConfirm={() => void removeMemory(pendingMemoryDelete)} open title="删除 CustomerMemory" />}
      {pendingMessageRemoval && <ConfirmDialog busy={messageAction === `remove-${pendingMessageRemoval.id}`} confirmLabel="确认隐藏" description="消息会从本演示工作台的会话中隐藏，审计记录仍然保留；此操作不代表抖音平台消息已撤回。" onCancel={() => setPendingMessageRemoval(undefined)} onConfirm={() => void removeMessage(pendingMessageRemoval)} open title="从会话隐藏这条消息？" />}
      {pendingAutoEnable && activeShop && <ConfirmDialog busy={conversationAction === 'enable-auto'} confirmLabel="确认开启" description={`这会把“${activeShop.name}”整店设置为允许 AUTO，并将当前会话设为 AUTO。只影响后续新任务；高风险消息仍会按规则转人工。`} onCancel={() => setPendingAutoEnable(false)} onConfirm={() => void enableShopAuto()} open title="开启整店 AUTO？" />}
      <section className="conversation-panel panel-surface" aria-label="会话列表">
        <div className="conversation-heading">
          <div><span className="overline">INBOX</span><h2>会话</h2></div>
          <span className="count-pill dark-pill">{visibleConversations.length}</span>
        </div>
        <div className="inbox-summary"><span><i className="summary-dot is-waiting" />待处理</span><strong>{visibleConversations.filter((item) => (item.unreadCount ?? 0) > 0).length}</strong><span className="summary-divider" /><span><i className="summary-dot is-ai" />AI 辅助</span></div>
        <label className="search-box"><span aria-hidden="true">⌕</span><input ref={queryInputRef} aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索买家、订单或消息" /><kbd>/</kbd></label>
        <SegmentedTabs label="会话筛选" value={conversationFilter} onChange={setConversationFilter} items={[{ value: 'all', label: '全部', count: conversations.length }, { value: 'unread', label: '未读', count: conversations.filter((item) => (item.unreadCount ?? 0) > 0).length }, { value: 'taken_over', label: '已接管', count: conversations.filter((item) => item.humanActive).length }]} />
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
            <div className="chat-heading-actions"><span className={`mode-chip mode-${String(effectiveMode).toLowerCase()}`} title="会话配置上限">上限 · {statusLabel(effectiveMode)}</span><label className="mode-select"><span className="sr-only">会话策略</span><select aria-label="会话策略" value={selectedMode} onChange={(event) => void changeConversationMode(event.currentTarget.value as WorkbenchConversationMode)} disabled={conversationAction !== ''}>{(['AUTO', 'ASSIST', 'MANUAL', 'HOLD'] as const).map((mode) => <option value={mode} key={mode} disabled={!isConversationModeAllowed(mode, activeShop?.aiMode)}>{conversationModeOptionLabel(mode, activeShop?.aiMode)}</option>)}</select></label>{!isConversationModeAllowed('AUTO', activeShop?.aiMode) && <button className="mode-unlock-button" type="button" onClick={() => setPendingAutoEnable(true)} disabled={conversationAction !== ''}>{conversationAction === 'enable-auto' ? '开启中…' : '一键开启 AUTO'}</button>}</div>
          </header>
           <div className="conversation-context-strip"><span>当前会话策略 · {statusLabel(selectedMode)}；会话配置上限 · {statusLabel(effectiveMode)}</span>{activeConversation.humanActive && <span className="risk-tag">人工接管中</span>}{activeConversation.syncState === 'DEGRADED' && <span className="risk-tag">连接降级 · 仅人工发送</span>}{activeConversation.needsReplan && <span className="risk-tag">消息已更新 · 正在重新规划</span>}</div>
           <div className="conversation-control-bar"><div className="control-summary"><span className={`control-dot ${activeConversation.humanActive || effectiveMode === 'MANUAL' ? 'is-human' : 'is-ai'}`} /><span>{activeConversation.humanActive ? '人工正在处理当前会话' : effectiveMode === 'MANUAL' ? 'MANUAL_ONLY · 需人工回复' : `当前策略 · ${statusLabel(effectiveMode)}`}</span></div><div className="control-actions">{activeConversation.humanActive ? <button type="button" className="outline-button compact-button" onClick={() => void resumeAi()} disabled={conversationAction !== ''}>{conversationAction === 'resume' ? '恢复中…' : '恢复 AI'}</button> : <button type="button" className="outline-button compact-button" onClick={() => void takeover()} disabled={conversationAction !== '' || activeConversation.state === 'CLOSED'}>{conversationAction === 'takeover' ? '接管中…' : '人工接管'}</button>}{effectiveMode !== 'ASSIST' && <button type="button" className="text-button" onClick={() => void changeConversationMode('ASSIST')} disabled={conversationAction !== ''}>设为 ASSIST</button>}</div></div>
          <div className="chat-stream">
            {messages.length === 0 ? <EmptyState title="等待消息" detail="Buyer Simulator 发来文本、商品卡或订单卡后会实时出现在这里。" /> : messages.map((message) => <MessageBubble actions={canSoftRemoveMessage(message) ? <button aria-label={`从会话隐藏消息 ${messageText(message) || messageKindLabel(message.kind)}`} className="message-remove-button" disabled={messageAction !== ''} onClick={() => setPendingMessageRemoval(message)} type="button">隐藏</button> : undefined} message={message} key={message.id} />)}
          </div>
          <section className={`draft-card ${draft?.status ? `draft-${draft.status.toLowerCase()}` : 'draft-empty'}`} aria-label="AI Draft 与 Human Final"><div className="draft-card-heading"><div className="draft-icon">✦</div><div><strong>AI 回复草稿</strong><span>{draft ? draftStatusLabel(draft.status) : activeConversation.humanActive ? '人工接管中，草稿暂停' : '等待生成回复草稿'}</span></div><span className={`draft-state ${draft?.status === 'STALE' || draft?.status === 'EXPIRED' ? 'is-danger' : ''}`}>{draft?.status ?? 'NONE'}</span>{draft?.expiresAt && draftCanEdit && <span className="draft-ttl">{draftRemainingLabel(draftRemaining)}</span>}</div>{draft ? <><textarea className="draft-editor" value={draftText} onChange={(event) => setDraftText(event.currentTarget.value)} disabled={!draftCanEdit} aria-label="Human Final 编辑区" rows={2} /><div className="draft-card-footer"><span>{draft.editType ? `差异 · ${draft.editType}` : draftCanEdit ? '草稿可编辑，发送前会重新校验会话状态' : draft.staleReason ?? '当前草稿不可发送'}</span><div className="draft-actions"><label className="draft-edit-type"><span>编辑类型</span><select value={draftEditType} onChange={(event) => setDraftEditType(event.currentTarget.value as NonNullable<ReplyDraft['editType']>)} disabled={!draftCanEdit} aria-label="Human Final 编辑类型"><option value="STYLE_EDIT">风格调整</option><option value="FACTUAL_CORRECTION">事实修正</option><option value="KNOWLEDGE_ENRICHMENT">知识补充</option></select></label><button type="button" className="text-button" onClick={applyDraftToComposer} disabled={!draftText.trim() || !draftCanEdit}>应用到回复</button>{draftCanEdit && <button type="button" className="outline-button compact-button" onClick={() => void sendDraft()} disabled={!draftText.trim() || isSending || activeConversation.humanActive}>{isSending ? '发送中…' : '发送人工定稿'}</button>}{(draft.status === 'STALE' || draft.status === 'EXPIRED' || draft.status === 'FAILED') && <button type="button" className="text-button" onClick={() => void regenerate()} disabled={draftAction !== '' || activeConversation.humanActive}>{draftAction === 'regenerate' ? '请求中…' : '重新生成'}</button>}</div></div></> : <div className="draft-empty-copy">买家发来新消息后，回复草稿会显示在这里。</div>}</section>
          {actionNotice && <p className="inline-notice is-success" role="status">{actionNotice}</p>}
          {sendError && <p className="inline-error" role="alert">{sendError}</p>}
          <div className="chat-composer"><textarea value={composer} onChange={(event) => setComposer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendHumanMessage(); } }} placeholder="以客服身份回复…" rows={2} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" type="button" onClick={() => void sendHumanMessage()} disabled={!composer.trim() || !selectedConversationId || isSending}>{isSending ? '发送中…' : '发送回复'}</button></div></div>
        </>}
      </section>

      <aside className="context-panel panel-surface" aria-label="业务上下文">
        <div className="context-heading"><div><span className="overline">CONTEXT</span><h2>业务上下文</h2></div></div>
        <div aria-label="业务上下文视图" className="context-tabs" role="tablist"><button aria-selected={contextTab === 'assistant'} role="tab" type="button" className={contextTab === 'assistant' ? 'is-active' : ''} onClick={() => setContextTab('assistant')}>助手</button><button aria-selected={contextTab === 'product'} role="tab" type="button" className={contextTab === 'product' ? 'is-active' : ''} onClick={() => setContextTab('product')}>商品</button><button aria-selected={contextTab === 'order'} role="tab" type="button" className={contextTab === 'order' ? 'is-active' : ''} onClick={() => setContextTab('order')}>订单</button><button aria-selected={contextTab === 'memory'} role="tab" type="button" className={contextTab === 'memory' ? 'is-active' : ''} onClick={() => setContextTab('memory')}>记忆</button></div>
        {contextTab === 'assistant' ? <div className="assistant-context"><div className="assistant-status-card"><span className="assistant-orb">✦</span><div><strong>{activeConversation?.humanActive ? '人工接管已开启' : 'AI 辅助准备就绪'}</strong><p>{activeShop ? `${activeShop.name} · ${modeLabel(activeShop.aiMode)}` : '选择店铺后加载策略'}</p></div></div><div className="context-section"><div className="section-label-row"><span>当前主题</span></div><strong>{activeConversation?.activeTopic ?? '尚未识别主题'}</strong><p className="muted-copy">商品、订单与售后事实会优先于知识库。</p>{activeConversation?.taskBundle && <div className="task-bundle"><div className="section-label-row"><span>处理任务 · {activeConversation.taskBundle.tasks.length}/4</span><span className="status-badge is-waiting">{taskStatusLabel(activeConversation.taskBundle.status)}</span></div>{activeConversation.taskBundle.tasks.map((task) => <div className="task-row" key={task.id}><span>{task.intent}</span><small>{taskStatusLabel(task.status)}</small></div>)}</div>}</div><div className="context-section"><div className="section-label-row"><span>快捷短语</span></div><div className="quick-phrases"><button type="button" onClick={() => setComposer('您好，我来帮您核对一下订单信息。')}>核对订单</button><button type="button" onClick={() => setComposer('我先为您确认库存和发货时效。')}>确认库存</button><button type="button" onClick={() => setComposer('请稍等，我为您转接人工客服。')}>转人工</button></div></div></div> : contextTab === 'product' ? <div className="context-scroll"><div className="context-intro"><span>当前商品与推荐候选</span><small>{contextProductList.length} 个结果</small></div>{contextProductList.length === 0 ? <ContextProduct /> : contextProductList.map((product) => <ContextProduct product={product} key={product.id} />)}</div> : contextTab === 'order' ? <div className="context-scroll"><div className="context-intro"><span>当前买家订单</span><small>{orders.length} 个结果</small></div>{activeOrder ? <ContextOrder order={activeOrder} /> : orders.length > 0 ? orders.map((order) => <ContextOrder order={order} key={order.id} />) : <ContextOrder />}</div> : <div className="context-scroll memory-context"><div className="context-intro"><span>人工 CustomerMemory</span><small>仅当前店铺 / 买家</small></div><div className="memory-form"><select value={memoryForm.type} onChange={(event) => setMemoryForm((current) => ({ ...current, type: event.currentTarget.value as CustomerMemoryInputDto['type'] }))} aria-label="记忆类型"><option value="PREFERENCE">偏好</option><option value="PRODUCT_PREFERENCE">商品偏好</option><option value="ONGOING_CASE">进行中事项</option></select><input value={memoryForm.key} onChange={(event) => setMemoryForm((current) => ({ ...current, key: event.currentTarget.value }))} placeholder="记忆键，例如 size" aria-label="记忆键" /><input value={memoryForm.value} onChange={(event) => setMemoryForm((current) => ({ ...current, value: event.currentTarget.value }))} placeholder="人工维护的事实" aria-label="记忆内容" /><div className="memory-form-actions"><button type="button" className="primary-button compact-button" onClick={() => void saveMemory()} disabled={!activeBuyer || !memoryForm.key.trim() || !memoryForm.value.trim() || memoryAction !== ''}>{memoryAction.startsWith('edit') ? '保存修改' : '新增记忆'}</button>{editingMemoryId && <button type="button" className="text-button" onClick={() => { setEditingMemoryId(''); setMemoryForm({ type: 'PREFERENCE', key: '', value: '' }); }}>取消编辑</button>}</div></div>{memories.length === 0 ? <EmptyState title="暂无人工记忆" detail="只有人工主动保存的偏好、商品偏好或进行中事项会进入这里。" /> : memories.map((memory) => <article className={`memory-card memory-${memory.status.toLowerCase()}`} key={memory.id}><div><strong>{memory.key}</strong><p>{typeof memory.value.text === 'string' ? memory.value.text : JSON.stringify(memory.value)}</p><small>{memory.type} · {memory.status}{memory.expiresAt ? ` · ${readableDate(memory.expiresAt)} 到期` : ''}</small></div><div className="memory-card-actions"><button type="button" className="text-button" onClick={() => { setEditingMemoryId(memory.id); setMemoryForm({ type: memory.type, key: memory.key, value: typeof memory.value.text === 'string' ? memory.value.text : JSON.stringify(memory.value) }); }}>编辑</button>{memory.status === 'ACTIVE' && <button type="button" className="text-button" onClick={() => void disableMemory(memory)} disabled={memoryAction !== ''}>停用</button>}<button type="button" className="text-button danger-button" onClick={() => setPendingMemoryDelete(memory)} disabled={memoryAction !== ''}>删除</button></div></article>)}</div>}
      </aside>
      <DeveloperTracePanel open={traceOpen} onClose={onTraceClose} loading={developerTraceLoading} error={developerTraceError} trace={developerTrace} conversationId={selectedConversationId} />
    </div>
  );
}
