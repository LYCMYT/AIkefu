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


export function importRowStatus(row: KnowledgeImportRow): 'READY' | 'DUPLICATE' | 'CONFLICT' | 'ERROR' {
  if (row.status === 'DUPLICATE' || row.status === 'CONFLICT' || row.status === 'ERROR') return row.status;
  if (String(row.status).toUpperCase() === 'NORMAL' || String(row.status).toUpperCase() === 'VALID') return 'READY';
  return 'READY';
}

export function importRowStatusLabel(status: string): string {
  return status === 'READY' ? '可导入' : status === 'DUPLICATE' ? '重复' : status === 'CONFLICT' ? '冲突' : '错误';
}

export function FormalKnowledgePage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
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
  const [pendingDelete, setPendingDelete] = useState<KnowledgeItem>();
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
      setPendingDelete(undefined);
    }
  };

  return <div className="admin-page knowledge-page">{pendingDelete && <ConfirmDialog busy={actionId === `delete-${pendingDelete.id}`} confirmLabel="确认删除" description={`“${pendingDelete.question}”将被 Soft Delete，并从可检索知识中移除。`} onCancel={() => setPendingDelete(undefined)} onConfirm={() => void remove(pendingDelete)} open title="删除知识条目" />}<AdminTabs active="knowledge" /><section className="admin-page-header panel-surface"><div><span className="overline">KNOWLEDGE OPERATIONS</span><h2>知识运营</h2><p>管理店铺与商品知识，分离业务状态和索引状态，保留每次版本切换的证据。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><button className="primary-button" type="button" onClick={() => { setImportOpen(true); setImportNotice(''); setPreview(undefined); setSelectedFile(undefined); }}><span className="button-plus">＋</span>导入知识</button></div></section><div className="metric-grid admin-metrics knowledge-metrics"><article><span>启用且可检索</span><strong className="metric-positive">{loading ? '—' : enabledReady}</strong><small>ENABLED + READY</small></article><article><span>全部知识</span><strong>{loading ? '—' : items.length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>索引处理中</span><strong className="metric-warm">{loading ? '—' : indexing}</strong><small>INDEXING / PENDING</small></article><article><span>冲突治理</span><strong className={conflicts ? 'metric-danger' : ''}>{loading ? '—' : conflicts}</strong><small>{conflicts ? '禁止自动检索' : '暂无冲突'}</small></article></div><section className="knowledge-list-card panel-surface"><div className="table-heading knowledge-heading"><div><span className="overline">SOURCE OF TRUTH</span><h3>正式知识</h3></div><span className="quiet-label">当前 Workspace · {filteredItems.length} 条</span></div><div className="knowledge-filters"><label className="knowledge-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索问题、答案或商品" /></label><select value={scopeFilter} onChange={(event) => setScopeFilter(event.currentTarget.value)}><option value="ALL">全部范围</option><option value="STORE">STORE 店铺</option><option value="PRODUCT">PRODUCT 商品</option></select><select value={sourceFilter} onChange={(event) => setSourceFilter(event.currentTarget.value)}><option value="ALL">全部来源</option><option value="MANUAL">MANUAL</option><option value="HUMAN_REVIEWED">HUMAN_REVIEWED</option><option value="AUTO_LEARNED">AUTO_LEARNED</option></select><select value={businessFilter} onChange={(event) => setBusinessFilter(event.currentTarget.value)}><option value="ALL">业务状态</option><option value="ENABLED">ENABLED</option><option value="DRAFT">DRAFT</option><option value="DISABLED">DISABLED</option><option value="OUTDATED">OUTDATED</option><option value="CONFLICTED">CONFLICTED</option><option value="DELETED">DELETED</option></select><select value={indexFilter} onChange={(event) => setIndexFilter(event.currentTarget.value)}><option value="ALL">索引状态</option><option value="READY">READY</option><option value="INDEXING">INDEXING</option><option value="PENDING">PENDING</option><option value="FAILED">FAILED</option></select></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="knowledge-table-wrap"><table className="knowledge-table"><thead><tr><th>问题 / 答案</th><th>范围</th><th>来源</th><th>业务状态</th><th>索引状态</th><th>版本</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-empty">正在读取知识快照…</td></tr> : filteredItems.length === 0 ? <tr><td colSpan={7} className="table-empty">{resourceError || '当前筛选没有知识条目。'}</td></tr> : filteredItems.map((item) => <tr key={item.id}><td><div className="knowledge-copy"><strong>{item.name ?? item.question}</strong>{item.name && <small className="knowledge-question">Q · {item.question}</small>}<small>A · {item.answer}</small>{item.productTitle && <em>{item.productTitle}</em>}</div></td><td><span className={`scope-badge scope-${item.scope.toLowerCase()}`}>{knowledgeScopeLabel(item.scope)}</span></td><td><span className="source-label">{knowledgeSourceLabel(item.sourceType)}</span></td><td><span className={`status-badge ${knowledgeStatusClass(item.businessStatus)}`}>{knowledgeBusinessLabel(item.businessStatus)}</span></td><td><span className={`index-label ${knowledgeStatusClass(item.indexStatus)}`}><i />{knowledgeIndexLabel(item.indexStatus)}</span></td><td><span className="version-label">v{knowledgeVersion(item)}</span></td><td><div className="row-actions"><button type="button" title="重新索引" onClick={() => void reindex(item)} disabled={actionId !== '' || item.businessStatus === 'DELETED'}>↻</button><button type="button" title="Soft delete" onClick={() => setPendingDelete(item)} disabled={actionId !== '' || item.businessStatus === 'DELETED'}>×</button></div></td></tr>)}</tbody></table></div></section>{importOpen && <div className="import-overlay" role="dialog" aria-modal="true" aria-labelledby="import-heading"><div className="import-drawer"><div className="import-drawer-heading"><div><span className="overline">KNOWLEDGE IMPORT</span><h2 id="import-heading">导入问答知识</h2><p>CSV / XLSX · 三列模板 · 不做整批回滚</p></div><button type="button" className="icon-button" onClick={() => setImportOpen(false)} aria-label="关闭">×</button></div><div className="import-template"><span className="template-icon">CSV</span><div><strong>商品ID（可选） · 问题 · 答案</strong><small>商品 ID 为空自动归类 STORE；填写后归类 PRODUCT</small></div><a href="/seed/knowledge-import-template.csv" download>下载模板</a></div><label className="file-drop"><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void onFileSelected(event.currentTarget.files?.[0])} /><span className="upload-icon">↑</span><strong>{selectedFile ? selectedFile.name : '选择或拖入文件'}</strong><small>支持 CSV / XLSX，服务端会再次校验编码、表头与长度</small></label>{previewLoading && <div className="preview-loading"><span className="loading-spinner" />正在生成预览…</div>}{preview && <><div className="import-counts"><div className="import-count is-ready"><strong>{visibleImportCounts.READY}</strong><span>可导入</span></div><div className="import-count is-duplicate"><strong>{visibleImportCounts.DUPLICATE}</strong><span>重复</span></div><div className="import-count is-conflict"><strong>{visibleImportCounts.CONFLICT}</strong><span>冲突</span></div><div className="import-count is-error"><strong>{visibleImportCounts.ERROR}</strong><span>错误</span></div></div><div className="import-preview-table"><table><thead><tr><th>行</th><th>范围 / 商品</th><th>问题</th><th>答案</th><th>校验</th></tr></thead><tbody>{importRows.length === 0 ? <tr><td colSpan={5} className="table-empty">任务已创建，服务端准备预览。</td></tr> : importRows.map((row) => { const status = importRowStatus(row); return <tr key={`${row.rowNumber}-${row.question}`} className={`import-row-${status.toLowerCase()}`}><td>{row.rowNumber}</td><td><span className={`scope-badge scope-${row.scope.toLowerCase()}`}>{knowledgeScopeLabel(row.scope)}</span><small>{row.productId || '店铺级'}</small></td><td>{row.question || '—'}</td><td>{row.answer || '—'}</td><td><span className={`import-status ${status.toLowerCase()}`}>{importRowStatusLabel(status)}</span>{row.reason && <small>{row.reason}</small>}</td></tr>; })}</tbody></table></div></>}{importNotice && <div className={`import-notice ${importNotice.includes('失败') || importNotice.includes('不可用') ? 'is-error' : ''}`} role="status">{importNotice}</div>}<div className="import-drawer-footer"><span>只有“可导入”行会进入 ENABLED；冲突需人工治理。</span><button type="button" className="outline-button" onClick={() => setImportOpen(false)}>取消</button><button type="button" className="primary-button" onClick={() => void commitImport()} disabled={!preview || !preview.id || previewLoading || actionId !== '' || preview.id === 'local-preview' || visibleImportCounts.READY === 0}>{actionId.startsWith('import-') ? '确认中…' : '确认导入'}</button></div></div></div>}</div>;
}

export type KnowledgeAdminView = 'formal' | 'candidates' | 'conflicts';

export function KnowledgeViewTabs({ active, onChange }: { active: KnowledgeAdminView; onChange: (view: KnowledgeAdminView) => void }) {
  return <div className="knowledge-view-tabs" role="tablist" aria-label="知识治理视图"><button aria-selected={active === 'formal'} role="tab" type="button" className={active === 'formal' ? 'is-active' : ''} onClick={() => onChange('formal')}>正式知识 <small>Published</small></button><button aria-selected={active === 'candidates'} role="tab" type="button" className={active === 'candidates' ? 'is-active' : ''} onClick={() => onChange('candidates')}>候选知识 <small>Review</small></button><button aria-selected={active === 'conflicts'} role="tab" type="button" className={active === 'conflicts' ? 'is-active' : ''} onClick={() => onChange('conflicts')}>冲突知识 <small>Resolve</small></button></div>;
}

export function KnowledgePage({ initialView = 'formal', ...props }: SharedViewProps & { initialView?: KnowledgeAdminView }) {
  const navigate = useNavigate();
  const [view, setView] = useState<KnowledgeAdminView>(initialView);
  useEffect(() => setView(initialView), [initialView]);
  const changeView = (nextView: KnowledgeAdminView) => {
    setView(nextView);
    navigate(nextView === 'formal' ? '/admin/knowledge' : nextView === 'candidates' ? '/admin/knowledge/candidates' : '/admin/knowledge/conflicts');
  };
  return <div className="knowledge-admin-shell"><KnowledgeViewTabs active={view} onChange={changeView} />{view === 'formal' ? <FormalKnowledgePage {...props} /> : view === 'candidates' ? <KnowledgeCandidatesPage {...props} /> : <KnowledgeConflictsPage {...props} />}</div>;
}

export function KnowledgeCandidatesPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
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

export function knowledgeCandidateStatusLabel(status?: string): string {
  const labels: Record<string, string> = { PENDING: '待审核', APPROVED: '已批准', PUBLISHED: '已发布', REJECTED: '已拒绝', DUPLICATE: '重复', CONFLICTED: '冲突' };
  return status ? labels[status] ?? status : '—';
}

export interface ConflictResolutionCardProps {
  conflict: KnowledgeConflict;
  items: KnowledgeItem[];
  busy: boolean;
  onResolve: (conflict: KnowledgeConflict, resolution: KnowledgeConflictResolution, customQuestion?: string, customAnswer?: string) => void;
}

export function ConflictResolutionCard({ conflict, items, busy, onResolve }: ConflictResolutionCardProps) {
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

export function KnowledgeConflictsPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
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
