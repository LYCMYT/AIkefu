import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ApiError, clearStoredWorkspaceToken, createWorkspace, getBootstrap, isWorkspaceCredentialError,
  readStoredWorkspaceToken, resetCurrentWorkspace, storeWorkspaceToken,
} from '../api';
import { connectWorkspaceSocket, type WorkspaceSocketEvent, type WorkspaceSocketStatus } from '../workspace-socket';
import { navIcons, navigationItems, resolveAppPath, type AppPath } from './routes';
import { DataPrivacyPage } from '../features/privacy/DataPrivacyPage';
import { UsageAdminPage } from '../features/usage/UsageAdminPage';
import { WorkbenchPage } from '../features/workbench/WorkbenchPage';
import { BuyerSimulatorPage } from '../features/buyer-simulator/BuyerSimulatorPage';
import { DashboardPage, ShopsAdminPage, ProductLearningPage } from '../features/dashboard/DashboardPage';
import { KnowledgePage } from '../features/knowledge/KnowledgePage';
import { WorkflowAdminPage } from '../features/workflows/WorkflowPage';
import { QualityPage } from '../features/quality/QualityPage';
import { IncidentPage } from '../features/incidents/IncidentPage';
import { ScenarioLabPage } from '../features/scenario-lab/ScenarioLabPage';
import {
  defaultNavigationItem, errorMessage, eventHasWorkspaceShape, isPhase03SnapshotEvent,
  modeLabel, shortId, traceRequestedBySearch, type FoundationState,
} from '../features/shared/view-models';
import type { Bootstrap as BootstrapPayload } from '@ai-customer-service/contracts';
import { AppShell } from '../components/layout/AppShell';

function PendingRoute({ path, bootstrap }: { path: AppPath; bootstrap?: BootstrapPayload }) {
  const item = navigationItems.find((entry) => entry.path === path) ?? defaultNavigationItem;
  return <section className="pending-route panel-surface"><span className="pending-orb">{navIcons[path]}</span><span className="overline">{item.note}</span><h2>{item.label}</h2><p>这个入口共享当前 Workspace。Phase 02 先聚焦消息管线、买家模拟器与客服工作台；其余业务模块会沿用同一套实时状态边界。</p><div className="pending-facts"><span><strong>{bootstrap?.seed.counts.shops ?? '—'}</strong> 店铺</span><span><strong>{bootstrap?.seed.counts.products ?? '—'}</strong> 商品</span><span><strong>{bootstrap?.seed.counts.knowledge ?? '—'}</strong> 知识条目</span></div></section>;
}

function FoundationError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return <section className="foundation-error panel-surface" role="alert"><span className="error-mark">!</span><div><span className="overline">CONNECTION CHECK</span><h2>尚未连接到 Foundation API</h2><p>{message}</p><button className="primary-button" type="button" onClick={onRetry}>重新连接</button></div></section>;
}

export default function Application() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = resolveAppPath(location.pathname);
  const [foundation, setFoundation] = useState<FoundationState>({ status: 'loading' });
  const [socketStatus, setSocketStatus] = useState<WorkspaceSocketStatus>('idle');
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [realtimeEvent, setRealtimeEvent] = useState<WorkspaceSocketEvent>();
  const [activeShopId, setActiveShopId] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [traceOpen, setTraceOpen] = useState(() => traceRequestedBySearch(window.location.search));
  const hasInitialized = useRef(false);
  const socketStatusRef = useRef<WorkspaceSocketStatus>('idle');

  const loadFoundation = useCallback(async (forceNewWorkspace = false) => {
    setFoundation((current) => ({ status: 'loading', bootstrap: current.bootstrap }));
    try {
      let token = forceNewWorkspace ? null : readStoredWorkspaceToken();
      if (!token) {
        const session = await createWorkspace();
        token = session.token;
        storeWorkspaceToken(token);
      }
      try {
        const bootstrap = await getBootstrap(token);
        setFoundation({ status: 'ready', bootstrap });
        setActiveShopId((current) => current && bootstrap.shops.some((shop) => shop.id === current) ? current : (bootstrap.shops[0]?.id ?? ''));
      } catch (error) {
        if (!forceNewWorkspace && isWorkspaceCredentialError(error)) {
          clearStoredWorkspaceToken();
          const session = await createWorkspace();
          storeWorkspaceToken(session.token);
          const bootstrap = await getBootstrap(session.token);
          setFoundation({ status: 'ready', bootstrap });
          setActiveShopId(bootstrap.shops[0]?.id ?? '');
          return;
        }
        throw error;
      }
    } catch (error) {
      setFoundation({ status: 'error', error: error instanceof ApiError ? error.message : 'Foundation 初始化失败，请稍后重试。' });
    }
  }, []);

  const refreshFoundation = useCallback(async () => {
    const token = readStoredWorkspaceToken();
    if (!token) return;
    try {
      const bootstrap = await getBootstrap(token);
      setFoundation((current) => ({ ...current, status: 'ready', bootstrap, error: undefined }));
      setSnapshotVersion((value) => value + 1);
    } catch (error) {
      if (isWorkspaceCredentialError(error)) {
        clearStoredWorkspaceToken();
        await loadFoundation(true);
      }
    }
  }, [loadFoundation]);

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    if (window.location.pathname === '/') navigate('/workbench', { replace: true });
    void loadFoundation();
  }, [loadFoundation, navigate]);

  const handleSocketStatus = useCallback((status: WorkspaceSocketStatus) => {
    const previous = socketStatusRef.current;
    socketStatusRef.current = status;
    setSocketStatus(status);
    if (status === 'connected' && previous === 'disconnected') void refreshFoundation();
  }, [refreshFoundation]);

  const handleSocketEvent = useCallback((event: WorkspaceSocketEvent) => {
    setRealtimeEvent(event);
    if (eventHasWorkspaceShape(event) || isPhase03SnapshotEvent(event)) setSnapshotVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    if (foundation.status !== 'ready') return;
    const token = readStoredWorkspaceToken();
    if (!token) return;
    return connectWorkspaceSocket(token, handleSocketStatus, handleSocketEvent);
  }, [foundation.status, foundation.bootstrap?.workspace.id, handleSocketEvent, handleSocketStatus]);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const token = readStoredWorkspaceToken();
      if (!token) {
        await loadFoundation(true);
        return;
      }
      await resetCurrentWorkspace(token);
      setSnapshotVersion((value) => value + 1);
      await loadFoundation();
    } catch (error) {
      if (isWorkspaceCredentialError(error)) {
        clearStoredWorkspaceToken();
        await loadFoundation(true);
      } else {
        setFoundation((current) => ({ ...current, status: 'error', error: errorMessage(error) }));
      }
    } finally {
      setIsResetting(false);
    }
  };

  const shops = foundation.bootstrap?.shops ?? [];
  const workspace = foundation.bootstrap?.workspace;
  const activeNav = path.startsWith('/admin/') ? navigationItems.find((item) => item.path === '/admin') ?? defaultNavigationItem : navigationItems.find((item) => item.path === path) ?? defaultNavigationItem;
  const routeTitle = path === '/admin'
    ? '数据概览'
    : path === '/admin/shops'
      ? '店铺配置'
      : path === '/admin/products'
        ? '商品学习'
        : path === '/admin/knowledge'
      ? '知识运营'
      : path === '/admin/knowledge/candidates'
        ? '候选知识'
        : path === '/admin/knowledge/conflicts'
          ? '冲突治理'
          : path === '/admin/workflows'
            ? '工作流'
            : path === '/admin/quality'
              ? '质检'
              : path === '/admin/incidents'
                ? '错误治理'
                : path === '/admin/usage'
                  ? '用量'
                  : path === '/admin/privacy'
                    ? '数据与隐私'
              : path === '/workbench'
                ? '消息工作台'
                : path === '/buyer-simulator'
                  ? '买家模拟器'
                  : path === '/scenario-lab'
                    ? '场景实验室'
                    : activeNav.label;
  const token = readStoredWorkspaceToken() ?? '';
  const socketLabel = socketStatus === 'connected' ? '实时已连接' : socketStatus === 'connecting' ? '正在连接' : socketStatus === 'disconnected' ? '等待重连' : '未连接';

  return (
    <AppShell activePath={path} activeShopId={activeShopId} isResetting={isResetting || foundation.status === 'loading'} onNavigate={(nextPath) => navigate(nextPath)} onReset={() => void handleReset()} onShopChange={setActiveShopId} onTraceToggle={() => setTraceOpen((value) => !value)} routeTitle={routeTitle} shops={shops} socketLabel={socketLabel} socketReady={socketStatus === 'connected'} traceOpen={traceOpen} workspaceId={workspace?.id}>
      {foundation.status === 'error' ? <FoundationError message={foundation.error} onRetry={() => void loadFoundation()} /> : foundation.status !== 'ready' || !token ? <section className="loading-screen panel-surface"><span className="loading-spinner" /><h2>正在准备 Workspace</h2><p>读取店铺、权限与实时连接…</p></section> : path === '/workbench' ? <WorkbenchPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} realtimeEvent={realtimeEvent} traceOpen={traceOpen} onTraceClose={() => setTraceOpen(false)} /> : path === '/buyer-simulator' ? <BuyerSimulatorPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin' ? <DashboardPage token={token} shops={shops} refreshKey={snapshotVersion} /> : path === '/admin/shops' ? <ShopsAdminPage shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} /> : path === '/admin/products' ? <ProductLearningPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/knowledge' || path === '/admin/knowledge/candidates' || path === '/admin/knowledge/conflicts' ? <KnowledgePage initialView={path === '/admin/knowledge/candidates' ? 'candidates' : path === '/admin/knowledge/conflicts' ? 'conflicts' : 'formal'} token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/workflows' ? <WorkflowAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/quality' ? <QualityPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/incidents' ? <IncidentPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/usage' ? <UsageAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/privacy' ? <DataPrivacyPage token={token} /> : path === '/scenario-lab' ? <ScenarioLabPage token={token} refreshKey={snapshotVersion} /> : <PendingRoute path={path} bootstrap={foundation.bootstrap} />}
    </AppShell>
  );
}
