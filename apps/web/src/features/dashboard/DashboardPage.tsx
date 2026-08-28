import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  approveActionProposal,
  ApiError,
  clearStoredWorkspaceToken,
  createWorkspace,
  createShop,
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
import { Drawer } from '../../components/ui/primitives';


export function AdminMetricCard({ label, snapshot, detail, tone = '' }: { label: string; snapshot: AdminMetricSnapshot; detail: string; tone?: string }) {
  return <article className="admin-overview-metric"><span>{label}</span><strong className={tone}>{snapshot.value === null ? '—' : snapshot.value.toLocaleString('zh-CN')}{snapshot.value !== null && label === '已质检通过率' ? '%' : ''}</strong><small>{detail}</small></article>;
}

export function metricSampleDetail(snapshot: AdminMetricSnapshot, available: string, unavailable: string): string {
  return snapshot.value === null ? unavailable : `${available} · 样本 ${snapshot.sampleSize}`;
}

export function DashboardPage({ token, shops, refreshKey }: Pick<SharedViewProps, 'token' | 'shops' | 'refreshKey'>) {
  const navigate = useNavigate();
  const [shopFilter, setShopFilter] = useState('ALL');
  const [periodDays, setPeriodDays] = useState<7 | 30>(7);
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

  const filteredShops = shopFilter === 'ALL' ? shops : shops.filter((shop) => shop.id === shopFilter);
  const filteredConversationsByShop = Object.fromEntries(Object.entries(conversationsByShop).filter(([shopId]) => shopFilter === 'ALL' || shopId === shopFilter));
  const snapshot = buildAdminOverviewSnapshot(filteredShops, filteredConversationsByShop, usage, qualityReviews);
  const allConversations = Object.values(filteredConversationsByShop).flat();
  const trend = buildConversationTrend(allConversations, new Date(), periodDays);
  const maxTrend = Math.max(1, ...trend.map((point) => point.count));
  const aiGenerated = usage ? usage.fastPathReplies + (usage.byPurpose.REPLY_GENERATION?.calls ?? 0) : null;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : null;
  const topicCounts = Array.from(allConversations.reduce((counts, conversation) => {
    const topic = conversation.activeTopic?.trim();
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()).sort((left, right) => right[1] - left[1]).slice(0, 5);
  const maxTopicCount = Math.max(1, ...topicCounts.map(([, count]) => count));

  return <div className="admin-page phase05-page admin-overview-page"><AdminTabs active="overview" /><Phase05AdminHeader overline="WORKSPACE OVERVIEW" title="数据概览" description="集中查看店铺连接、会话、AI 用量与质检状态。" actions={<div className="overview-filters"><label><span>店铺</span><select aria-label="总览店铺" value={shopFilter} onChange={(event) => setShopFilter(event.currentTarget.value)}><option value="ALL">全部店铺</option>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select></label><label><span>时间范围</span><select aria-label="总览时间范围" value={periodDays} onChange={(event) => setPeriodDays(Number(event.currentTarget.value) === 30 ? 30 : 7)}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label></div>} />
    {resourceError && <div className="inline-notice" role="status">{resourceError}</div>}
    {loading ? <Phase05LoadingState label="正在读取店铺、会话、用量与质检快照…" /> : <>
      <section className="admin-overview-metric-grid" aria-label="Workspace 指标">
        <AdminMetricCard label="在线店铺" snapshot={snapshot.onlineShops} detail={metricSampleDetail(snapshot.onlineShops, 'CONNECTED 店铺', '暂无店铺快照')} tone="metric-positive" />
        <AdminMetricCard label="今日进线" snapshot={snapshot.todayInbound} detail={metricSampleDetail(snapshot.todayInbound, '按会话时间戳', '暂无有效会话时间戳')} />
        <AdminMetricCard label="AI 生成" snapshot={{ value: aiGenerated, sampleSize: usage ? 1 : 0 }} detail={usage ? 'Fast Path + Reply Generation' : '暂无 AI 用量快照'} />
        <AdminMetricCard label="人工接管" snapshot={snapshot.humanTakeover} detail={metricSampleDetail(snapshot.humanTakeover, '当前接管会话', '暂无会话')} tone="metric-warm" />
      </section>
      <section className="admin-overview-grid"><section className="overview-chart-card panel-surface" aria-labelledby="conversation-trend-heading"><div className="phase05-list-heading"><div><span className="overline">CONVERSATION TREND</span><h3 id="conversation-trend-heading">会话趋势</h3></div><span className="quiet-label">最近 {periodDays} 天 · {allConversations.length} 条会话</span></div><div className={`overview-bars range-${periodDays}`}>{trend.map((point) => <div className="overview-bar-column" key={point.key}><span className="overview-bar-value">{point.count || '—'}</span><div className="overview-bar-track"><i style={{ height: `${Math.max(point.count ? 12 : 3, (point.count / maxTrend) * 100)}%` }} /></div><small>{point.label}</small></div>)}</div><p className="overview-footnote">趋势仅统计已返回且时间有效的真实会话；不会补造缺失日期的业务量。</p></section><section className="overview-topic-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">ACTIVE TOPICS</span><h3>当前问题分布</h3></div><span className="quiet-label">真实主题</span></div>{topicCounts.length ? <div className="overview-topic-list">{topicCounts.map(([topic, count]) => <div key={topic}><span>{topic}</span><div><i style={{ width: `${Math.max(8, (count / maxTopicCount) * 100)}%` }} /></div><strong>{count}</strong></div>)}</div> : <EmptyState title="暂无可统计主题" detail="会话完成意图识别后，这里会展示真实主题分布。" />}</section></section>
      <section className="overview-secondary-grid"><section className="overview-usage-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">AI USAGE</span><h3>AI 用量</h3></div><button className="text-button" type="button" onClick={() => navigate('/admin/usage')}>查看明细</button></div><div className="overview-usage-metrics"><div><span>调用次数</span><strong>{usage?.calls ?? '—'}</strong></div><div><span>Token 总量</span><strong>{totalTokens === null ? '—' : totalTokens.toLocaleString('zh-CN')}</strong></div><div><span>Fallback</span><strong>{usage?.fallbacks ?? '—'}</strong></div><div><span>失败</span><strong>{usage?.failures ?? '—'}</strong></div></div><p>用量来自 Workspace UsageSummary；未配置服务端价格表时不估算费用。</p></section><section className="overview-quality-card panel-surface"><div className="phase05-list-heading"><div><span className="overline">QUALITY SIGNAL</span><h3>质检与回复路径</h3></div><span className="quiet-label">样本优先</span></div><div className="overview-signal-list"><div><span>快速回复</span><strong>{snapshot.fastPath.value ?? '—'}</strong></div><div><span>模型回复</span><strong>{snapshot.llmReply.value ?? '—'}</strong></div><div><span>已质检通过率</span><strong>{snapshot.qualityPassRate.value === null ? '—' : `${snapshot.qualityPassRate.value}%`}</strong></div></div></section></section>
      <section className="overview-actions panel-surface"><div><span className="overline">NEXT OPERATIONS</span><h3>继续操作</h3><p>选择下一项日常运营任务。</p></div><div className="overview-action-buttons"><button className="primary-button" type="button" onClick={() => navigate('/admin/shops')}>管理店铺</button><button className="outline-button" type="button" onClick={() => navigate('/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => navigate('/admin/usage')}>查看 AI 用量</button><button className="outline-button" type="button" onClick={() => navigate('/workbench')}>打开工作台</button></div></section>
    </>}
  </div>;
}

export function ShopsAdminPage({ token, shops, activeShopId, onShopChange, onFoundationRefresh }: Pick<SharedViewProps, 'token' | 'shops' | 'activeShopId' | 'onShopChange' | 'onFoundationRefresh'>) {
  const navigate = useNavigate();
  const selectedShopId = activeShopId || shops[0]?.id || '';
  const [createOpen, setCreateOpen] = useState(false);
  const [shopName, setShopName] = useState('');
  const [templateKey, setTemplateKey] = useState('FASHION_DEMO');
  const [shopAction, setShopAction] = useState('');
  const [notice, setNotice] = useState('');
  const openForShop = (shopId: string, path: AppPath) => {
    onShopChange(shopId);
    navigate(path);
  };

  const addShop = async () => {
    setShopAction('create');
    setNotice('');
    try {
      const shop = await createShop(token, {
        platform: 'DOUYIN_DEMO',
        templateKey,
        ...(shopName.trim() ? { name: shopName.trim() } : {}),
      });
      onShopChange(shop.id);
      await onFoundationRefresh?.();
      setCreateOpen(false);
      setShopName('');
      setNotice(`已添加“${shop.name}”并自动选中，可继续设置回复方式或进入工作台。`);
    } catch (error) {
      setNotice(`添加失败：${errorMessage(error)}`);
    } finally {
      setShopAction('');
    }
  };

  const changeShopMode = async (shopId: string, mode: ShopSummary['aiMode']) => {
    setShopAction(`mode-${shopId}`);
    setNotice('');
    try {
      const updated = await updateShopAiMode(token, shopId, mode);
      await onFoundationRefresh?.();
      setNotice(mode === 'AUTO_ALLOWED'
        ? `“${updated.name}”已允许低风险消息自动回复；设置只影响后续新任务。`
        : `“${updated.name}”已切换为${mode === 'ASSIST_ONLY' ? '辅助回复' : '仅人工'}。`);
    } catch (error) {
      setNotice(`模式更新失败：${errorMessage(error)}`);
    } finally {
      setShopAction('');
    }
  };

  return <div className="admin-page phase05-page shops-admin-page"><AdminTabs active="shops" /><section className="admin-page-header panel-surface"><div><span className="overline">SHOP CONTROL</span><h2>店铺配置</h2><p>添加模拟店铺、设置 AI 回复上限，然后直接进入对应工作台。</p></div><button className="primary-button shop-create-trigger" type="button" onClick={() => setCreateOpen(true)}>＋ 添加店铺</button></section>
    {notice && <div className={`inline-notice ${notice.includes('失败') ? '' : 'is-success'}`} role="status">{notice}</div>}
    {shops.length === 0 ? <EmptyState title="暂无店铺" detail="点击“添加店铺”，使用演示模板立即创建。" /> : <section className="shops-admin-grid" aria-label="店铺列表">{shops.map((shop) => { const selected = shop.id === selectedShopId; return <article className={`shop-admin-card panel-surface ${selected ? 'is-selected' : ''}`} key={shop.id}><div className="shop-admin-card-heading"><div className="shop-admin-identity"><span className="shop-admin-mark">{shop.name.slice(0, 1).toUpperCase()}</span><div><span className="overline">{shop.platform === 'DOUYIN_DEMO' ? '模拟抖音店铺' : shop.platform}</span><h3>{shop.name}</h3><small>{shop.externalShopId ? `店铺编号 · ${shortId(shop.externalShopId)}` : '暂无外部店铺编号'}</small></div></div><span className={`status-badge ${phase05StatusClass(shop.connectionState)}`}><i className={`shop-status-dot is-${shop.connectionState.toLowerCase()}`} />{connectionStateLabel(shop.connectionState)}</span></div><div className="shop-admin-facts"><div className="shop-ai-mode-fact"><label htmlFor={`shop-mode-${shop.id}`}>AI 回复方式</label><select id={`shop-mode-${shop.id}`} aria-label={`${shop.name} AI 回复方式`} value={shop.aiMode} onChange={(event) => void changeShopMode(shop.id, event.currentTarget.value as ShopSummary['aiMode'])} disabled={shopAction !== ''}><option value="AUTO_ALLOWED">自动回复（仅低风险）</option><option value="ASSIST_ONLY">辅助回复（人工发送）</option><option value="MANUAL_ONLY">仅人工</option></select><small>{shop.aiMode === 'AUTO_ALLOWED' ? '低风险新任务可自动发送' : shop.aiMode === 'ASSIST_ONLY' ? 'AI 生成草稿，由人工确认发送' : 'AI 不自动生成或发送回复'}</small></div><div><span>商品同步</span><strong>{shop.syncComplete ? '已完成' : '待同步'}</strong></div><div><span>平台</span><strong>模拟抖音</strong></div></div><div className="shop-admin-actions"><button className="primary-button" type="button" onClick={() => openForShop(shop.id, '/workbench')}>打开工作台</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/products')}>商品同步 / 学习</button><button className="outline-button" type="button" onClick={() => openForShop(shop.id, '/admin/knowledge')}>知识运营</button></div></article>; })}</section>}
    <Drawer open={createOpen} onClose={() => { if (shopAction !== 'create') setCreateOpen(false); }} title="添加店铺"><div className="shop-create-form"><p>模板会复制合成演示商品、订单与知识，并复用当前 Workspace 的合成买家；不会连接真实抖音。</p><label className="compact-field"><span>店铺名称（可选）</span><input aria-label="店铺名称" value={shopName} onChange={(event) => setShopName(event.currentTarget.value)} placeholder="例如：我的演示店" maxLength={40} /></label><label className="compact-field"><span>演示模板</span><select aria-label="演示模板" value={templateKey} onChange={(event) => setTemplateKey(event.currentTarget.value)}><option value="FASHION_DEMO">服饰店基础设置</option><option value="TECH_DEMO">数码店基础设置</option></select></label><div className="shop-create-summary"><span>平台</span><strong>MockDouyin（本地演示）</strong><small>不会连接、创建或修改真实抖音店铺。</small></div><div className="shop-create-actions"><button className="outline-button" type="button" onClick={() => setCreateOpen(false)} disabled={shopAction === 'create'}>取消</button><button className="primary-button" type="button" onClick={() => void addShop()} disabled={shopAction === 'create'}>{shopAction === 'create' ? '添加中…' : '添加并选中'}</button></div></div></Drawer>
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

  return <div className="admin-page product-learning-page"><AdminTabs active="products" /><section className="admin-page-header panel-surface"><div><span className="overline">PRODUCT INTELLIGENCE</span><h2>商品学习</h2><p>同步商品信息，并把稳定内容整理为可检索知识。</p></div><div className="admin-header-controls"><label className="compact-field"><span>当前店铺</span><select value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>{shops.map((shop) => <option value={shop.id} key={shop.id}>{shop.name}</option>)}</select></label><button className="outline-button" type="button" onClick={() => void runAction('sync')} disabled={busyAction !== '' || !shopId}>↻ 同步商品</button><button className="primary-button" type="button" onClick={() => void runAction('learn')} disabled={busyAction !== '' || !shopId}>{busyAction === 'learn' ? '提交中…' : '开始学习'}</button></div></section><div className="metric-grid admin-metrics"><article><span>商品总数</span><strong>{loading ? '—' : products.length}</strong><small>{activeShop?.name ?? '当前店铺'}</small></article><article><span>已完成</span><strong className="metric-positive">{loading ? '—' : completed}</strong><small>可用于知识检索</small></article><article><span>学习中</span><strong className="metric-warm">{loading ? '—' : processing}</strong><small>正在整理内容</small></article><article><span>失败待重试</span><strong className={failed ? 'metric-danger' : ''}>{loading ? '—' : failed}</strong><small>{failed ? '需要重新学习' : '队列健康'}</small></article></div><section className="learning-progress-card panel-surface"><div className="progress-card-heading"><div><span className="overline">LEARNING JOB</span><h3>{latestJob ? `任务 ${shortId(latestJob.id)}` : '尚未启动学习任务'}</h3></div><div className="job-state"><span className={`status-badge ${learningStatusClass(latestJob?.status)}`}>{learningStatusLabel(latestJob?.status)}</span><small>{latestJob?.updatedAt ? readableTime(latestJob.updatedAt) : '等待提交'}</small></div></div><div className="big-progress"><span style={{ width: `${progress}%` }} /></div><div className="progress-foot"><span><strong>{progress}%</strong> 已完成</span><span>{latestJob?.completed ?? completed} / {latestJob?.total ?? products.length} 个商品</span><span>{latestJob?.failed ?? failed} 个失败</span></div></section><section className="product-table-card panel-surface"><div className="table-heading"><div><span className="overline">CATALOG SNAPSHOT</span><h3>商品目录</h3></div><div className="table-actions"><button type="button" className="small-button" onClick={selectAll}>{selectedIds.length === products.length && products.length ? '取消全选' : '全选'}</button><button type="button" className="small-button retry-button" onClick={() => void runAction('retry')} disabled={busyAction !== '' || (!failedIds.length && !selectedIds.length)}>↻ 重试失败项</button></div></div>{resourceError && <div className="inline-notice">{resourceError}</div>}<div className="product-table-wrap"><table className="product-table"><thead><tr><th><span className="sr-only">选择</span></th><th>商品</th><th>SKU / 价格</th><th>库存</th><th>商品状态</th><th>学习状态</th><th>知识条目</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="table-empty">正在读取商品与学习快照…</td></tr> : products.length === 0 ? <tr><td colSpan={7} className="table-empty">{resourceError || '当前店铺暂无商品。'}</td></tr> : productWithStatus.map(({ product, summary, learningItem, status }) => { const sku = firstSku(product); const count = knowledge.filter((item) => item.productId === product.id).length || summary?.knowledgeCount || 0; return <tr key={product.id}><td><input type="checkbox" checked={selectedIds.includes(product.id)} onChange={() => toggleSelected(product.id)} aria-label={`选择${productName(product)}`} /></td><td><div className="product-cell"><span className="table-product-art">✦</span><div><strong>{productName(product)}</strong><small>{product.externalProductId ?? shortId(product.id)}</small></div></div></td><td><strong>{productPrice(product)}</strong><small className="table-subline">{sku?.externalSkuId ?? 'SKU —'}</small></td><td>{productInventory(product)}</td><td><span className={`status-badge ${product.status === 'ON_SHELF' ? 'is-positive' : 'is-muted'}`}>{statusLabel(product.status)}</span></td><td><span className={`learning-state ${learningStatusClass(status)}`}><i />{learningStatusLabel(status)}</span>{(learningItem?.reason || summary?.error) && <small className="table-error">{learningItem?.reason ?? summary?.error}</small>}</td><td><span className="knowledge-count">{count || '—'}</span></td></tr>; })}</tbody></table></div></section>{notice && <div className={`action-toast ${notice.includes('已') || notice.includes('提交') ? 'is-success' : ''}`} role="status">{notice}</div>}</div>;
}
