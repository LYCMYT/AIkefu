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

export function IncidentPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
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
