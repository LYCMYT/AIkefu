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


export function AdminMetricCard({ label, snapshot, detail, tone = '' }: { label: string; snapshot: AdminMetricSnapshot; detail: string; tone?: string }) {
  return <article className="admin-overview-metric"><span>{label}</span><strong className={tone}>{snapshot.value === null ? '—' : snapshot.value.toLocaleString('zh-CN')}{snapshot.value !== null && label === '已质检通过率' ? '%' : ''}</strong><small>{detail}</small></article>;
}

export function metricSampleDetail(snapshot: AdminMetricSnapshot, available: string, unavailable: string): string {
  return snapshot.value === null ? unavailable : `${available} · 样本 ${snapshot.sampleSize}`;
}

export function DashboardPage({ token, shops, refreshKey }: Pick<SharedViewProps, 'token' | 'shops' | 'refreshKey'>) {
  const navigate = useNavigate();
  const overview = useQuery({
    queryKey: ['admin-overview', token, shops.map((shop) => shop.id).join(','), refreshKey],
    queryFn: async () => {
      const [conversationResults, usageResult, qualityResult] = await Promise.all([
        Promise.allSettled(shops.map((shop) => getConversations(token, shop.id))),
        Promise.allSettled([getUsageSummary(token)]).then(([result]) => result!),
        Promise.allSettled([getQualityReviews(token)]).then(([result]) => result!),
      ]);
      const conversationsByShop: Record<string, Conversation[]> = {};
      let failedSources = 0;
      shops.forEach((shop, index) => {
        const result = conversationResults[index];
        if (result?.status === 'fulfilled') conversationsByShop[shop.id] = result.value;
        else failedSources += 1;
      });
      const usage = usageResult.status === 'fulfilled' ? usageResult.value : undefined;
      if (!usage) failedSources += 1;
      const qualityReviews = qualityResult.status === 'fulfilled' ? qualityResult.value : [];
      if (qualityResult.status === 'rejected') failedSources += 1;
      return { conversationsByShop, usage, qualityReviews, failedSources };
    },
  });

  const conversationsByShop = overview.data?.conversationsByShop ?? {};
  const usage = overview.data?.usage;
  const qualityReviews = overview.data?.qualityReviews ?? [];
  const loading = overview.isLoading;
  const resourceError = overview.isError
    ? errorMessage(overview.error)
    : overview.data?.failedSources
      ? '部分 Workspace 数据暂不可用；以下仅展示已返回的真实样本，不推断缺失指标。'
      : '';

  const snapshot = buildAdminOverviewSnapshot(shops, conversationsByShop, usage, qualityReviews);
  const allConversations = Object.values(conversationsByShop).flat();
  const trend = buildConversationTrend(allConversations);
  const maxTrend = Math.max(1, ...trend.map((point) => point.count));

  return <div className="admin-page phase05-page admin-overview-page"><AdminTabs active="overview" /><Phase05AdminHeader overline="WORKSPACE OVERVIEW" title="数据概览" description="当前 Workspace 的真实 Demo 快照。缺少服务端汇总时显示不可用，不把调用量包装成商业 KPI。" />
    {resourceError && <div className="inline-notice" role="status">{resourceError}</div>}
    {loading ? <Phase05LoadingState label="正在读取店铺、会话、用量与质检快照…" /> : <>
      <section className="admin-overview-metric-grid" aria-label="Workspace 指标">
        <AdminMetricCard label="在线店铺" snapshot={snapshot.onlineShops} detail={metricSampleDetail(snapshot.onlineShops, 'CONNECTED 店铺', '暂无店铺快照')} tone="metric-positive" />
        <AdminMetricCard label="今日进线" snapshot={snapshot.todayInbound} detail={metricSampleDetail(snapshot.todayInbound, '按会话时间戳', '暂无有效会话时间戳')} />
        <AdminMetricCard label="AI 回复" snapshot={{ value: null, sampleSize: snapshot.aiUsage.sampleSize }} detail="当前 API 未提供已发送 AI 回复汇总；不从调用量推断。" />
        <AdminMetricCard label="人工接管" snapshot={snapshot.humanTakeover} detail={metricSampleDetail(snapshot.humanTakeover, '当前 humanActive 会话', '暂无会话快照')} tone="metric-warm" />
        <AdminMetricCard label="Fast Path" snapshot={snapshot.fastPath} detail={metricSampleDetail(snapshot.fastPath, 'FAST_CHAT usage calls', '暂无 usage 快照')} tone="metric-positive" />
        <AdminMetricCard label="LLM Reply" snapshot={snapshot.llmReply} detail={metricSampleDetail(snapshot.llmReply, 'REPLY_GENERATION calls', '暂无 purpose 分项')} />
        <AdminMetricCard label="AI Usage" snapshot={snapshot.aiUsage} detail={metricSampleDetail(snapshot.aiUsage, 'AI invocation calls', '暂无 usage 快照')} />
        <AdminMetricCard label="已质检通过率" snapshot={snapshot.qualityPassRate} detail={metricSampleDetail(snapshot.qualityPassRate, '已完成质检记录', '暂无已完成质检样本')} tone="metric-positive" />
      </section>
      <div className="admin-overview-grid">
        <section className="overview-chart-card panel-surface" aria-labelledby="conversation-trend-heading"><div className="phase05-list-heading"><div><span className="overline">CONVERSATION TREND</span><h3 id="conversation-trend-heading">会话趋势</h3></div><span className="quiet-label">最近 7 天 · {allConversations.length} 条返回样本</span></div><div className="overview-bars">{trend.map((point) => <div className="overview-bar-column" key={point.key}><span className="overview-bar-value">{point.count || '—'}</span><div className="overview-bar-track"><i style={{ height: `${Math.max(point.count ? 12 : 3, (point.count / maxTrend) * 100)}%` }} /></div><small>{point.label}</small></div>)}</div><p className="overview-footnote">趋势按各店铺 conversations 接口返回的时间戳计算，不代表全平台历史进线量。</p></section>
        <section className="overview-source-card panel-surface" aria-labelledby="overview-source-heading"><div className="phase05-list-heading"><div><span className="overline">SOURCE COVERAGE</span><h3 id="overview-source-heading">数据来源与边界</h3></div><span className="observe-only">NO FAKE KPI</span></div><div className="overview-source-list"><div><strong>店铺 / 连接</strong><span>Bootstrap · {shops.length} 家</span><em>真实</em></div><div><strong>会话趋势 / 接管</strong><span>按店铺 conversations 快照</span><em>{allConversations.length ? '样本' : '不可用'}</em></div><div><strong>AI Usage</strong><span>UsageSummary · calls / tokens / fallback</span><em>{usage ? '真实' : '不可用'}</em></div><div><strong>质检通过率</strong><span>仅统计已完成且有结论的记录</span><em>{snapshot.qualityPassRate.sampleSize ? `n=${snapshot.qualityPassRate.sampleSize}` : '暂无'}</em></div></div></section>
      </div>
      <div className="admin-overview-grid overview-secondary-grid"><section className="overview-list-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">POPULAR QUESTIONS</span><h3>热门问题</h3></div><span className="observe-only">NOT EXPOSED</span></div><EmptyState title="暂无问题聚合接口" detail="当前 Workspace API 只返回会话摘要，未提供可验证的热门问题聚合，因此不显示推测图表。" /></section><section className="overview-list-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">KNOWLEDGE / HANDOFF</span><h3>知识命中与转人工原因</h3></div><span className="observe-only">NOT EXPOSED</span></div><EmptyState title="暂无可用汇总" detail="知识命中与转人工原因尚未由现有 Workspace API 汇总；请进入知识、质检或工作台查看逐条证据。" /></section></div>
      <section className="overview-actions panel-surface"><div><span className="overline">NEXT OPERATIONS</span><h3>继续操作</h3><p>所有入口都保持在现有 MockDouyin 与 Workspace-scoped API 边界内。</p></div><div className="overview-action-buttons"><button className="primary-button" type="button" onClick={() => navigate('/admin/shops')}>管理店铺</button><button className="outline-button" type="button" onClick={() => navigate('/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => navigate('/admin/usage')}>查看 AI 用量</button><button className="outline-button" type="button" onClick={() => navigate('/workbench')}>打开工作台</button></div></section>
    </>}
  </div>;
}

export function ShopsAdminPage({ shops, activeShopId, onShopChange }: Pick<SharedViewProps, 'shops' | 'activeShopId' | 'onShopChange'>) {
  const navigate = useNavigate();
  const selectedShopId = activeShopId || shops[0]?.id || '';
  const openForShop = (shopId: string, path: AppPath) => {
    onShopChange(shopId);
    navigate(path);
  };

  return <div className="admin-page phase05-page shops-admin-page"><AdminTabs active="shops" /><Phase05AdminHeader overline="SHOP CONTROL" title="店铺配置" description="查看当前 Workspace 的 MockDouyin 店铺连接状态与 ShopAIMode；设置入口复用已有工作台、商品学习与知识运营 API。" />
    {shops.length === 0 ? <EmptyState title="暂无店铺快照" detail="Bootstrap 尚未返回当前 Workspace 的店铺。" /> : <section className="shops-admin-grid" aria-label="店铺列表">{shops.map((shop) => { const selected = shop.id === selectedShopId; return <article className={`shop-admin-card panel-surface ${selected ? 'is-selected' : ''}`} key={shop.id}><div className="shop-admin-card-heading"><div className="shop-admin-identity"><span className="shop-admin-mark">{shop.name.slice(0, 1).toUpperCase()}</span><div><span className="overline">{shop.platform === 'DOUYIN_DEMO' ? 'MOCKDOUYIN' : shop.platform}</span><h3>{shop.name}</h3><small>{shop.externalShopId ? `External · ${shortId(shop.externalShopId)}` : 'External shop id 未返回'}</small></div></div><span className={`status-badge ${phase05StatusClass(shop.connectionState)}`}><i className={`shop-status-dot is-${shop.connectionState.toLowerCase()}`} />{connectionStateLabel(shop.connectionState)}</span></div><div className="shop-admin-facts"><div><span>ShopAIMode</span><strong>{modeLabel(shop.aiMode)}</strong><small>{shop.aiMode}</small></div><div><span>商品同步</span><strong>{shop.syncComplete ? '已完成' : '待同步'}</strong><small>{shop.syncComplete ? 'Bootstrap syncComplete' : '以商品学习页为准'}</small></div><div><span>平台</span><strong>MockDouyinAdapter</strong><small>V1 仅 Mock 平台</small></div></div><div className="shop-admin-actions"><button className="primary-button" type="button" onClick={() => openForShop(shop.id, '/workbench')}>打开工作台</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/knowledge')}>知识运营</button></div><div className="shop-admin-settings-note"><span className="note-icon">i</span><p><strong>设置入口</strong> 已连接到现有 Workspace 操作页；物流、发货、售后、欢迎语与违禁词未新增未验证的写入 API。</p></div></article>; })}</section>}
    <section className="shop-admin-boundary panel-surface"><div><span className="overline">FROZEN V1 BOUNDARY</span><h3>连接与权限边界</h3></div><div className="shop-boundary-grid"><div><strong>平台</strong><span>仅 MockDouyinAdapter</span><small>不接真实平台 API、Cookie 或 Token。</small></div><div><strong>AI 模式</strong><span>AUTO_ALLOWED · ASSIST_ONLY · MANUAL_ONLY</span><small>此页展示服务端快照；模式变更沿用已实现会话策略边界。</small></div><div><strong>可操作入口</strong><span>工作台 · 商品学习 · 知识运营</span><small>点击店铺卡片内按钮可带着当前店铺进入对应页面。</small></div></div></section>
  </div>;
}

export function ProductLearningPage({ token, shops, activeShopId, onShopChange, refreshKey }: SharedViewProps) {
  const [shopId, setShopId] = useState(activeShopId || shops[0]?.id || '');
  const [products, setProducts] = useState<Product[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [jobs, setJobs] = useState<ProductLearningJob[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'sync' | 'learn' | 'retry' | ''>('');
  const [notice, setNotice] = useState('');
  const [resourceError, setResourceError] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);

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
    Promise.allSettled([getProducts(token, shopId), getKnowledge(token, { shopId }), getProductLearningJobs(token, shopId)]).then((results) => {
      if (!mounted) return;
      const [productResult, knowledgeResult, jobResult] = results;
      const errors: unknown[] = [];
      if (productResult.status === 'fulfilled') setProducts(productResult.value); else errors.push(productResult.reason);
      if (knowledgeResult.status === 'fulfilled') setKnowledge(knowledgeResult.value); else setKnowledge([]);
      if (jobResult.status === 'fulfilled') setJobs(jobResult.value); else setJobs([]);
      if (errors.length) setResourceError(errorMessage(errors[0]));
      setSelectedIds((current) => current.filter((id) => productResult.status === 'fulfilled' && productResult.value.some((product) => product.id === id)));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [localRefresh, refreshKey, shopId, token]);

  const activeShop = shops.find((shop) => shop.id === shopId);
  const latestJob = jobs[0];
  const latestJobItems = latestJob?.items ?? [];
  const learningItemByProduct = new Map(latestJobItems.map((item) => [item.productId, item]));
  const productWithStatus = products.map((product) => {
    const summary = product.learning ?? product.learningSummary;
    const learningItem = learningItemByProduct.get(product.id);
    const status = learningItem?.status ?? summary?.status ?? (latestJob?.status === 'RUNNING' ? 'PROCESSING' : undefined);
    return { product, summary, learningItem, status };
  });
  const completed = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'SUCCEEDED').length : productWithStatus.filter(({ status }) => status === 'SUCCEEDED').length;
  const processing = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'PROCESSING' || item.status === 'PENDING').length : productWithStatus.filter(({ status }) => status === 'PROCESSING' || status === 'PENDING').length;
  const failed = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'FAILED').length : productWithStatus.filter(({ status }) => status === 'FAILED').length;
  const progress = learningProgress(latestJob, products);
  const failedIds = latestJobItems.length ? latestJobItems.filter((item) => item.status === 'FAILED').map((item) => item.productId) : productWithStatus.filter(({ status }) => status === 'FAILED').map(({ product }) => product.id);

  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const selectAll = () => setSelectedIds(selectedIds.length === products.length ? [] : products.map((product) => product.id));

  const runAction = async (action: 'sync' | 'learn' | 'retry') => {
    if (!shopId) return;
    setBusyAction(action);
    setNotice('');
    try {
      if (action === 'sync') {
        await syncProducts(token, shopId);
        setNotice('商品同步任务已提交');
      } else if (action === 'retry') {
        await startProductLearning(token, shopId, { productIds: selectedIds.length ? selectedIds : failedIds, retryFailed: true });
        setNotice('失败商品已重新加入学习队列');
      } else {
        const targetIds = selectedIds.length ? selectedIds : products.map((product) => product.id);
        await startProductLearning(token, shopId, { productIds: targetIds.length ? targetIds : undefined });
        setNotice(selectedIds.length ? `已提交 ${selectedIds.length} 个商品的学习` : '全量商品学习任务已提交');
      }
      setLocalRefresh((value) => value + 1);
      setSelectedIds([]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusyAction('');
    }
  };

  return <div className="admin-page product-learning-page"><AdminTabs active="products" /><section className="admin-page-header panel-surface"><div><span className="overline">PRODUCT INTELLIGENCE</span><h2>商品学习</h2><p>同步商品动态事实，再把稳定详情送入 ProductKnowledge 与索引。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><button className="outline-button" type="button" onClick={() => void runAction('sync')} disabled={busyAction !== '' || !shopId}>↻ 同步商品</button><button className="primary-button" type="button" onClick={() => void runAction('learn')} disabled={busyAction !== '' || !shopId}>{busyAction === 'learn' ? '提交中…' : '开始学习'}</button></div></section><div className="metric-grid admin-metrics"><article><span>商品总数</span><strong>{loading ? '—' : products.length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>已完成</span><strong className="metric-positive">{loading ? '—' : completed}</strong><small>ProductKnowledge ready</small></article><article><span>学习中</span><strong className="metric-warm">{loading ? '—' : processing}</strong><small>结构化抽取 / 索引</small></article><article><span>失败待重试</span><strong className={failed ? 'metric-danger' : ''}>{loading ? '—' : failed}</strong><small>{failed ? '需要重新学习' : '队列健康'}</small></article></div><section className="learning-progress-card panel-surface"><div className="progress-card-heading"><div><span className="overline">LEARNING JOB</span><h3>{latestJob ? `Job ${shortId(latestJob.id)}` : '尚未启动学习任务'}</h3></div><div className="job-state"><span className={`status-badge ${learningStatusClass(latestJob?.status)}`}>{learningStatusLabel(latestJob?.status)}</span><small>{latestJob?.updatedAt ? readableTime(latestJob.updatedAt) : '等待提交'}</small></div></div><div className="big-progress"><span style={{ width: `${progress}%` }} /></div><div className="progress-foot"><span><strong>{progress}%</strong> 已完成</span><span>{latestJob?.completed ?? completed} / {latestJob?.total ?? products.length} 个商品</span><span>{latestJob?.failed ?? failed} 个失败</span></div></section><div className="learning-main-grid"><section className="product-table-card panel-surface"><div className="table-heading"><div><span className="overline">CATALOG SNAPSHOT</span><h3>商品目录</h3></div><div className="table-actions"><button type="button" className="small-button" onClick={selectAll}>{selectedIds.length === products.length && products.length ? '取消全选' : '全选'}</button><button type="button" className="small-button retry-button" onClick={() => void runAction('retry')} disabled={busyAction !== '' || (!failedIds.length && !selectedIds.length)}>↻ 重试失败项</button></div></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="product-table-wrap"><table className="product-table"><thead><tr><th><span className="sr-only">选择</span></th><th>商品</th><th>SKU / 价格</th><th>库存</th><th>商品状态</th><th>学习状态</th><th>知识条目</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-empty">正在读取商品与学习快照…</td></tr> : products.length === 0 ? <tr><td colSpan={7} className="table-empty">{resourceError || '当前店铺暂无商品。'}</td></tr> : productWithStatus.map(({ product, summary, learningItem, status }) => { const sku = firstSku(product); const count = knowledge.filter((item) => item.productId === product.id).length || summary?.knowledgeCount || 0; return <tr key={product.id}><td><input type="checkbox" checked={selectedIds.includes(product.id)} onChange={() => toggleSelected(product.id)} aria-label={`选择${productName(product)}`} /></td><td><div className="product-cell"><span className="table-product-art">✦</span><div><strong>{productName(product)}</strong><small>{product.externalProductId ?? shortId(product.id)}</small></div></div></td><td><strong>{productPrice(product)}</strong><small className="table-subline">{sku?.externalSkuId ?? 'SKU —'}</small></td><td>{productInventory(product)}</td><td><span className={`status-badge ${product.status === 'ON_SHELF' ? 'is-positive' : 'is-muted'}`}>{statusLabel(product.status)}</span></td><td><span className={`learning-state ${learningStatusClass(status)}`}><i />{learningStatusLabel(status)}</span>{(learningItem?.reason || summary?.error) && <small className="table-error">{learningItem?.reason ?? summary?.error}</small>}</td><td><span className="knowledge-count">{count || '—'}</span></td></tr>; })}</tbody></table></div></section><aside className="runtime-observe"><section className="runtime-card panel-surface"><div className="runtime-card-heading"><div><span className="overline">AI RUNTIME</span><h3>运行状态</h3></div><span className="observe-only">OBSERVE ONLY</span></div><p>这里展示可观察结果；Provider、模型与密钥由服务端路由，不在前端配置。</p><div className="runtime-check"><span className="runtime-check-icon is-ready">✓</span><div><strong>结构化抽取</strong><small>Schema validation · repair once</small></div><em>READY</em></div><div className="runtime-check"><span className="runtime-check-icon is-ready">✓</span><div><strong>Hybrid RAG</strong><small>Keyword + vector · Top K 3</small></div><em>READY</em></div><div className="runtime-check"><span className="runtime-check-icon is-waiting">…</span><div><strong>当前索引</strong><small>{knowledge.length ? `${knowledge.filter((item) => item.indexStatus === 'READY').length} 条 Ready` : '等待知识快照'}</small></div><em>{knowledge.length ? 'LIVE' : 'PENDING'}</em></div></section><section className="runtime-note panel-surface"><span className="note-icon">i</span><div><strong>事实与知识分开</strong><p>价格、库存和订单状态始终来自实时业务上下文，不会进入向量检索。</p></div></section></aside></div>{notice && <div className={`action-toast ${notice.includes('已') || notice.includes('提交') ? 'is-success' : ''}`} role="status">{notice}</div>}</div>;
}
