import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock3, Play, RotateCcw, Search } from 'lucide-react';
import { approveActionProposal, ApiError, clearStoredWorkspaceToken, createWorkspace, editBuyerMessage, getBootstrap, getBuyers, getConversation, getConversationTrace, getConversations, getCustomerMemories, getKnowledge, getKnowledgeCandidates, getKnowledgeConflicts, getProductLearningJobs, getOrders, getProducts, isWorkspaceCredentialError, messageText, recallBuyerMessage, regenerateReply, resumeConversationAi, readStoredWorkspaceToken, resetCurrentWorkspace, setConversationMode, sendBuyerMessage, sendBuyerOrderCard, sendBuyerProductCard, sendConversationMessage, storeWorkspaceToken, takeoverConversation, createCustomerMemory, disableCustomerMemory, deleteCustomerMemory, draftRemainingMs, mergeCustomerMemoryMutation, updateCustomerMemory, commitKnowledgeImport, approveKnowledgeCandidate, classifyImportRows, deleteKnowledge, getIncidents, getQualityReviews, addIncidentRegression, concludeQualityReview, getScenarios, getUsageSummary, getWorkflow, getWorkflowRuns, getWorkflows, parseKnowledgeCsv, previewKnowledgeImport, reindexKnowledge, rejectKnowledgeCandidate, rejectActionProposal, resolveIncident, saveIncidentCorrection, saveIncidentRootCause, disableWorkflow, enableWorkflow, publishWorkflow, saveWorkflowDraft, startQualityReview, resolveKnowledgeConflict, resetScenario, runScenario, startProductLearning, syncProducts, type Buyer, type Conversation, type ExistingKnowledgeMatch, type KnowledgeImportPreview, type KnowledgeImportRow, type KnowledgeCandidate, type KnowledgeConflict, type KnowledgeConflictResolution, type KnowledgeItem, type ProductLearningJob, type ProductLearningStatus, type Message, type Order, type Product, type ReplyDraft, type CustomerMemory, type CustomerMemoryInputDto, type QualityReview, type QualityResult, type DeveloperTrace, type ReplyIncident, type Scenario, type SendOutbox, type ShopSummary, type UsageSummary, type Workflow, type WorkflowGraph, type WorkflowRun } from '../../api';
import { connectWorkspaceSocket, refreshConversationForWorkspaceEvent, type WorkspaceSocketEvent, type WorkspaceSocketStatus } from '../../workspace-socket';
import { buyerTextSubmissionEnabled, humanFinalSubmission } from '../../workbench-actions';
import { navIcons, navigationItems, resolveAppPath, type AppPath } from '../../app/routes';
import { EmptyState, ErrorState as Phase05ErrorState, LoadingState as Phase05LoadingState } from '../../components/ui/feedback';
import { AdminPageHeader as Phase05AdminHeader, AdminTabs } from '../admin/AdminChrome';
import { DataPrivacyPage } from '../privacy/DataPrivacyPage';
import { UsageAdminPage } from '../usage/UsageAdminPage';
import type { Bootstrap as BootstrapPayload, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '@ai-customer-service/contracts';

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

export function ScenarioLabPage({ token, refreshKey }: Pick<SharedViewProps, 'token' | 'refreshKey'>) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [resourceError, setResourceError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setResourceError('');
    return getScenarios(token)
      .then((next) => {
        setScenarios(next);
      })
      .catch((error: unknown) => {
        setScenarios([]);
        setResourceError(errorMessage(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!selectedKey && scenarios[0]) setSelectedKey(scenarios[0].key);
    if (selectedKey && !scenarios.some((scenario) => scenario.key === selectedKey)) setSelectedKey(scenarios[0]?.key ?? '');
  }, [scenarios, selectedKey]);

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

  const visibleScenarios = scenarios.filter((scenario) => `${scenario.name} ${scenario.description ?? ''} ${scenario.expectedResult ?? ''}`.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN')));
  const selected = scenarios.find((scenario) => scenario.key === selectedKey) ?? visibleScenarios[0];
  const passed = selected?.steps?.filter((step) => step.status === 'SUCCEEDED').length ?? 0;
  const failed = selected?.steps?.filter((step) => step.status === 'FAILED').length ?? 0;
  const completedScenarios = scenarios.filter((item) => item.lastRunAt).length;
  const passedScenarios = scenarios.filter((item) => item.status === 'SUCCEEDED' && item.lastRunAt).length;

  return (
    <div className='scenario-lab-page'>
      <header className='scenario-lab-header'>
        <div>
          <span className='overline'>SCENARIO LAB · SYNTHETIC</span>
          <h2>场景实验室</h2>
          <p>固定八个合成场景，运行结果、步骤状态和 Trace 全部来自当前 Workspace。</p>
        </div>
        <div className='scenario-scope-note'>
          <span>V1 安全边界</span>
          <strong>MockDouyin · 不连接真实平台</strong>
        </div>
      </header>
      {notice && (
        <div className='inline-notice' role='status'>
          {notice}
        </div>
      )}
      {loading ? (
        <Phase05LoadingState label='正在读取场景快照…' />
      ) : resourceError ? (
        <Phase05ErrorState message={resourceError} />
      ) : scenarios.length === 0 ? (
        <EmptyState title='暂无场景快照' detail='Scenario API 尚未返回当前 Workspace 的固定场景。' />
      ) : (
        <div className='scenario-lab-layout'>
          <aside className='scenario-index panel-surface'>
            <div className='scenario-index-heading'>
              <div>
                <strong>测试场景</strong>
                <small>{scenarios.length} 个固定 Case · 与运营店铺隔离</small>
              </div>
              <span className='ui-badge'>{completedScenarios === 0 ? `${scenarios.length} 项未运行` : `${passedScenarios}/${completedScenarios} 已通过`}</span>
            </div>
            <label className='scenario-search'>
              <Search aria-hidden='true' size={16} />
              <input aria-label='搜索场景' onChange={(event) => setQuery(event.currentTarget.value)} placeholder='搜索名称或预期结果' value={query} />
            </label>
            <div className='scenario-index-list'>
              {visibleScenarios.map((scenario, index) => (
                <button className={scenario.key === selected?.key ? 'is-active' : ''} key={scenario.key} onClick={() => setSelectedKey(scenario.key)} type='button'>
                  <span className='scenario-case-number'>{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <strong>{scenario.name}</strong>
                    <small>{scenario.expectedResult ?? scenario.description ?? '等待运行'}</small>
                  </span>
                  <i className={`status-dot ${phase05StatusClass(scenario.status)}`} />
                </button>
              ))}
            </div>
          </aside>
          {selected && (
            <main className='scenario-detail panel-surface'>
              <header className='scenario-detail-heading'>
                <div>
                  <span className='overline'>{selected.key}</span>
                  <h3>{selected.name}</h3>
                  <p>{selected.description ?? '服务端未提供场景说明。'}</p>
                </div>
                <span className={`status-badge ${phase05StatusClass(selected.status)}`}>{statusLabel(selected.status)}</span>
              </header>
              <section aria-label='场景参数' className='scenario-parameter-strip'>
                <span>
                  数据
                  <strong>{selected.synthetic ? '合成隔离' : '未知'}</strong>
                </span>
                <span>
                  平台<strong>MockDouyin</strong>
                </span>
                <span>
                  步骤<strong>{selected.steps?.length ?? 0}</strong>
                </span>
                <span>
                  Trace<strong>{selected.traceId ? '已生成' : '待生成'}</strong>
                </span>
              </section>
              <section className='scenario-metric-row'>
                <div>
                  <CheckCircle2 aria-hidden='true' size={18} />
                  <span>通过步骤</span>
                  <strong>{passed}</strong>
                </div>
                <div>
                  <AlertTriangle aria-hidden='true' size={18} />
                  <span>失败步骤</span>
                  <strong>{failed}</strong>
                </div>
                <div>
                  <Clock3 aria-hidden='true' size={18} />
                  <span>最近运行</span>
                  <strong>{selected.lastRunAt ? readableTime(selected.lastRunAt) : '未运行'}</strong>
                </div>
              </section>
              <section className='scenario-expectation'>
                <span className='overline'>EXPECTED RESULT</span>
                <p>{selected.expectedResult ?? '服务端未提供预期结果。'}</p>
              </section>
              <section className='scenario-timeline'>
                <div className='scenario-section-heading'>
                  <div>
                    <span className='overline'>EXECUTION TIMELINE</span>
                    <h4>执行步骤</h4>
                  </div>
                  <small>{selected.steps?.length ?? 0} steps</small>
                </div>
                {selected.steps?.length ? (
                  selected.steps.map((step, index) => (
                    <article className={`scenario-step ${phase05StatusClass(step.status)}`} key={step.key}>
                      <span className='scenario-step-line' />
                      <span className='scenario-step-index'>{index + 1}</span>
                      <div>
                        <strong>{step.label}</strong>
                        <p>{step.actual ?? step.expected ?? '等待运行后返回实际结果。'}</p>
                      </div>
                      <span className={`status-badge ${phase05StatusClass(step.status)}`}>{statusLabel(step.status)}</span>
                    </article>
                  ))
                ) : (
                  <EmptyState title='暂无执行步骤' detail='运行场景后，服务端步骤会按时间顺序显示在这里。' />
                )}
              </section>
              <footer className='scenario-detail-actions'>
                <div>
                  <small>{selected.traceId ? `Trace · ${selected.traceId}` : '尚未生成 Trace'}</small>
                  <span>{selected.status === 'FAILED' ? '失败结果会保留，不会伪装为成功。' : '每次运行均使用隔离 synthetic 数据。'}</span>
                </div>
                <button className='outline-button' disabled={busyKey !== ''} onClick={() => void run(selected, 'reset')} type='button'>
                  <RotateCcw aria-hidden='true' size={15} />
                  {busyKey === `reset:${selected.key}` ? '重置中…' : '重置'}
                </button>
                <button className='primary-button' disabled={busyKey !== ''} onClick={() => void run(selected, 'run')} type='button'>
                  <Play aria-hidden='true' size={15} />
                  {busyKey === `run:${selected.key}` ? '运行中…' : '运行场景'}
                </button>
              </footer>
            </main>
          )}
        </div>
      )}
    </div>
  );
}
