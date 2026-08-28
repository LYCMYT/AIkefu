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


import * as viewModel from '../shared/view-models';
const { defaultNavigationItem, readableTime, readableDate, shortId, buyerName, productName, orderName, statusLabel, errorMessage, modeLabel, connectionStateLabel, localDayKey, conversationTimestamp, metric, buildAdminOverviewSnapshot, buildConversationTrend, isConversationModeAllowed, conversationModeOptionLabel, replyJobStatusLabel, draftStatusLabel, sendOutboxStatusLabel, draftRemainingLabel, taskStatusLabel, tagsFromBuyer, firstSku, productPrice, productInventory, objectValue, redactTraceValue, redactDeveloperTracePayload, shouldLoadDeveloperTrace, traceRequestedBySearch, visibleDeveloperTraceEvents, isMessage, cardData, messageKindLabel, messageRoleLabel, messageSort, knowledgeScopeLabel, knowledgeSourceLabel, knowledgeBusinessLabel, knowledgeIndexLabel, knowledgeVersion, knowledgeStatusClass, learningStatusLabel, learningStatusClass, learningProgress, eventHasWorkspaceShape, isPhase03SnapshotEvent } = viewModel;
type FoundationState = viewModel.FoundationState;
type SharedViewProps = viewModel.SharedViewProps;
type AdminMetricSnapshot = viewModel.AdminMetricSnapshot;
type AdminOverviewSnapshot = viewModel.AdminOverviewSnapshot;
type ConversationTrendPoint = viewModel.ConversationTrendPoint;
type WorkbenchConversationMode = viewModel.WorkbenchConversationMode;

import { Avatar, MessageBubble, ShopRail, ContextProduct, ContextOrder, DeveloperTracePanel } from '../workbench/components';

import { phase05StatusClass } from '../workflows/WorkflowPage';


export function QualityPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
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
