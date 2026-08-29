import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ApiError, createWorkspace, getBootstrap, isWorkspaceCredentialError, resetCurrentWorkspace,
} from '../api';
import { connectWorkspaceSocket, type WorkspaceSocketEvent, type WorkspaceSocketStatus } from '../workspace-socket';
import { matchWorkbenchRoute, navIcons, navigationItems, resolveAppPath, type AppPath } from './routes';
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
import { ShopSettingsPage } from '../features/settings/ShopSettingsPage';
import { KnowledgeImportPage } from '../features/knowledge/KnowledgeImportPage';
import { LiveTestPage } from '../features/live-test/LiveTestPage';
import {
  defaultNavigationItem, errorMessage, eventHasWorkspaceShape, isPhase03SnapshotEvent,
  modeLabel, shortId, traceRequestedBySearch, type FoundationState,
} from '../features/shared/view-models';
import type { Bootstrap as BootstrapPayload } from '@ai-customer-service/contracts';
import { AppShell } from '../components/layout/AppShell';
import {
  clearWorkspaceSessionToken,
  readWorkspaceSessionToken,
  storeWorkspaceSessionToken,
  workspaceSessionProfile,
  workspaceSessionResetProfile,
  WorkspaceSessionRequestGate,
  type WorkspaceSessionKind,
} from './workspace-session';
import { confirmNavigation, UNSAVED_SETTINGS_MESSAGE } from './navigation-guard';

function PendingRoute({ path, bootstrap }: { path: AppPath; bootstrap?: BootstrapPayload }) {
  const item = navigationItems.find((entry) => entry.path === path) ?? defaultNavigationItem;
  const iconPath = path.startsWith('/workbench') ? '/workbench' : path.startsWith('/admin') ? '/admin' : path === '/buyer-simulator' || path === '/scenario-lab' ? path : '/workbench';
  return <section className="pending-route panel-surface"><span className="pending-orb">{navIcons[iconPath]}</span><span className="overline">{item.note}</span><h2>{item.label}</h2><p>这个入口共享当前 Workspace。Phase 02 先聚焦消息管线、买家模拟器与客服工作台；其余业务模块会沿用同一套实时状态边界。</p><div className="pending-facts"><span><strong>{bootstrap?.seed.counts.shops ?? '—'}</strong> 店铺</span><span><strong>{bootstrap?.seed.counts.products ?? '—'}</strong> 商品</span><span><strong>{bootstrap?.seed.counts.knowledge ?? '—'}</strong> 知识条目</span></div></section>;
}

function FoundationError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return <section className="foundation-error panel-surface" role="alert"><span className="error-mark">!</span><div><span className="overline">CONNECTION CHECK</span><h2>尚未连接到 Foundation API</h2><p>{message}</p><button className="primary-button" type="button" onClick={onRetry}>重新连接</button></div></section>;
}

function historyIndex(): number | undefined {
  const value = window.history.state?.idx;
  return typeof value === 'number' ? value : undefined;
}

function locationPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export default function Application() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = resolveAppPath(location.pathname);
  const workbenchRoute = matchWorkbenchRoute(location.pathname);
  const sessionKind: WorkspaceSessionKind = path === '/scenario-lab' ? 'scenario' : 'operational';
  const [foundation, setFoundation] = useState<FoundationState>({ status: 'loading' });
  const [socketStatus, setSocketStatus] = useState<WorkspaceSocketStatus>('idle');
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [realtimeEvent, setRealtimeEvent] = useState<WorkspaceSocketEvent>();
  const [activeShopId, setActiveShopId] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const acceptedLocationRef = useRef({ pathname: locationPath(), index: historyIndex() });
  const restoringHistoryRef = useRef(false);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [traceOpen, setTraceOpen] = useState(() => traceRequestedBySearch(window.location.search));
  const sessionGateRef = useRef(new WorkspaceSessionRequestGate(sessionKind));
  // Update this during render, before passive effects run, so an old async
  // closure cannot commit operational data into a newly rendered scenario.
  sessionGateRef.current.activate(sessionKind);
  const socketStatusRef = useRef<WorkspaceSocketStatus>('idle');

  const loadFoundation = useCallback(async (forceNewWorkspace = false) => {
    const requestedKind = sessionKind;
    const requestGate = sessionGateRef.current;
    const request = requestGate.begin(requestedKind);
    if (!request) return;
    const isCurrentRequest = () => requestGate.isCurrent(request);
    setFoundation((current) => ({ status: 'loading', bootstrap: current.bootstrap }));
    try {
      let token = forceNewWorkspace ? null : readWorkspaceSessionToken(requestedKind);
      if (!token) {
        const profile = workspaceSessionProfile(requestedKind);
        const session = await createWorkspace(profile ? { profile } : undefined);
        if (!isCurrentRequest()) return;
        token = session.token;
        storeWorkspaceSessionToken(requestedKind, token);
      }
      try {
        const bootstrap = await getBootstrap(token);
        if (!isCurrentRequest()) return;
        setFoundation({ status: 'ready', bootstrap });
        setActiveShopId((current) => current && bootstrap.shops.some((shop) => shop.id === current) ? current : (bootstrap.shops[0]?.id ?? ''));
      } catch (error) {
        if (!isCurrentRequest()) return;
        if (!forceNewWorkspace && isWorkspaceCredentialError(error)) {
          clearWorkspaceSessionToken(requestedKind);
          const profile = workspaceSessionProfile(requestedKind);
          const session = await createWorkspace(profile ? { profile } : undefined);
          if (!isCurrentRequest()) return;
          storeWorkspaceSessionToken(requestedKind, session.token);
          const bootstrap = await getBootstrap(session.token);
          if (!isCurrentRequest()) return;
          setFoundation({ status: 'ready', bootstrap });
          setActiveShopId(bootstrap.shops[0]?.id ?? '');
          return;
        }
        throw error;
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      setFoundation({ status: 'error', error: error instanceof ApiError ? error.message : 'Foundation 初始化失败，请稍后重试。' });
    }
  }, [sessionKind]);

  const refreshFoundation = useCallback(async () => {
    const requestedKind = sessionKind;
    const requestGate = sessionGateRef.current;
    const request = requestGate.begin(requestedKind);
    if (!request) return;
    const isCurrentRequest = () => requestGate.isCurrent(request);
    const token = readWorkspaceSessionToken(requestedKind);
    if (!token) return;
    try {
      const bootstrap = await getBootstrap(token);
      if (!isCurrentRequest()) return;
      setFoundation((current) => ({ ...current, status: 'ready', bootstrap, error: undefined }));
      setSnapshotVersion((value) => value + 1);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (isWorkspaceCredentialError(error)) {
        clearWorkspaceSessionToken(requestedKind);
        await loadFoundation(true);
      }
    }
  }, [loadFoundation, sessionKind]);

  useEffect(() => {
    const refresh = () => { void refreshFoundation(); };
    window.addEventListener('aikefu:foundation-refresh', refresh);
    return () => window.removeEventListener('aikefu:foundation-refresh', refresh);
  }, [refreshFoundation]);

  useEffect(() => {
    if (window.location.pathname === '/') navigate('/workbench', { replace: true });
    setActiveShopId('');
    setRealtimeEvent(undefined);
    socketStatusRef.current = 'idle';
    setSocketStatus('idle');
    void loadFoundation();
  }, [loadFoundation, navigate, sessionKind]);

  // Every route is a new page-level task. Preserve internal panel scroll, but
  // never carry the previous page's document position into the next route.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  useEffect(() => {
    if (settingsDirty || restoringHistoryRef.current) return;
    acceptedLocationRef.current = { pathname: locationPath(), index: historyIndex() };
  }, [location.pathname, location.search, location.hash, settingsDirty]);

  // BrowserRouter's BrowserHistory does not expose useBlocker, so guard the
  // one navigation path that bypasses AppShell handlers (Back/Forward) at the
  // history boundary. A declined pop is reversed to the accepted entry. Keep
  // this listener mounted for the whole app: a form change and a browser
  // Back can happen before the next render installs a state-dependent effect.
  useLayoutEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (restoringHistoryRef.current) {
        event.stopImmediatePropagation();
        restoringHistoryRef.current = false;
        return;
      }
      const accepted = acceptedLocationRef.current;
      const nextPath = locationPath();
      if (nextPath === accepted.pathname) return;
      if (!settingsDirtyRef.current) {
        acceptedLocationRef.current = { pathname: nextPath, index: historyIndex() };
        return;
      }
      if (confirmNavigation(true, accepted.pathname, nextPath, window.confirm)) {
        settingsDirtyRef.current = false;
        setSettingsDirty(false);
        acceptedLocationRef.current = { pathname: nextPath, index: historyIndex() };
        return;
      }
      // Stop BrowserRouter from committing the destination before the user has
      // answered. The compensating history.go below then preserves form state.
      event.stopImmediatePropagation();
      const nextIndex = historyIndex();
      if (accepted.index !== undefined && nextIndex !== undefined && accepted.index !== nextIndex) {
        restoringHistoryRef.current = true;
        window.history.go(accepted.index - nextIndex);
      } else {
        // React Router's history state normally has an idx. This fallback is
        // for a host that supplied a custom history entry without one.
        restoringHistoryRef.current = true;
        navigateRef.current(accepted.pathname, { replace: true });
        restoringHistoryRef.current = false;
      }
    };
    window.addEventListener('popstate', onPopState, true);
    return () => window.removeEventListener('popstate', onPopState, true);
  }, []);

  useEffect(() => {
    if (workbenchRoute.kind === 'home') return;
    if (foundation.bootstrap?.shops.some((shop) => shop.id === workbenchRoute.shopId)) setActiveShopId(workbenchRoute.shopId);
  }, [foundation.bootstrap?.shops, workbenchRoute.kind, 'shopId' in workbenchRoute ? workbenchRoute.shopId : '']);

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
    const requestedKind = sessionKind;
    const token = readWorkspaceSessionToken(requestedKind);
    if (!token) return;
    const belongsToActiveSession = () => (
      sessionGateRef.current.isActive(requestedKind)
      && readWorkspaceSessionToken(requestedKind) === token
    );
    return connectWorkspaceSocket(
      token,
      (status) => { if (belongsToActiveSession()) handleSocketStatus(status); },
      (event) => { if (belongsToActiveSession()) handleSocketEvent(event); },
    );
  }, [foundation.status, foundation.bootstrap?.workspace.id, handleSocketEvent, handleSocketStatus, sessionKind]);

  const handleReset = async () => {
    const requestedKind = sessionKind;
    const requestGate = sessionGateRef.current;
    const request = requestGate.begin(requestedKind);
    if (!request) return;
    const isCurrentRequest = () => requestGate.isCurrent(request);
    setIsResetting(true);
    try {
      const token = readWorkspaceSessionToken(requestedKind);
      if (!token) {
        await loadFoundation(true);
        return;
      }
      const profile = workspaceSessionResetProfile(requestedKind);
      await resetCurrentWorkspace(token, profile ? { profile } : undefined);
      if (!isCurrentRequest()) return;
      setSnapshotVersion((value) => value + 1);
      await loadFoundation();
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (isWorkspaceCredentialError(error)) {
        clearWorkspaceSessionToken(requestedKind);
        await loadFoundation(true);
      } else {
        setFoundation((current) => ({ ...current, status: 'error', error: errorMessage(error) }));
      }
    } finally {
      setIsResetting(false);
    }
  };

  const guardedNavigate = useCallback((nextPath: AppPath) => {
    if (!confirmNavigation(settingsDirtyRef.current, location.pathname, nextPath, window.confirm)) return;
    settingsDirtyRef.current = false;
    setSettingsDirty(false);
    navigate(nextPath);
  }, [location.pathname, navigate]);

  const guardedShopChange = useCallback((shopId: string) => {
    const nextPath = path.startsWith('/workbench')
      ? `/workbench/shops/${encodeURIComponent(shopId)}` as AppPath
      : path.startsWith('/live-test/')
        ? `/live-test/${encodeURIComponent(shopId)}` as AppPath
        : undefined;
    if (nextPath && !confirmNavigation(settingsDirtyRef.current, location.pathname, nextPath, window.confirm)) return;
    settingsDirtyRef.current = false;
    setSettingsDirty(false);
    setActiveShopId(shopId);
    if (nextPath) navigate(nextPath);
  }, [location.pathname, navigate, path]);

  const guardedReset = useCallback(() => {
    if (settingsDirtyRef.current && !window.confirm(UNSAVED_SETTINGS_MESSAGE)) return;
    settingsDirtyRef.current = false;
    setSettingsDirty(false);
    void handleReset();
  }, [handleReset]);

  const handleSettingsDirtyChange = useCallback((dirty: boolean) => {
    settingsDirtyRef.current = dirty;
    setSettingsDirty(dirty);
  }, []);

  const shops = foundation.bootstrap?.shops ?? [];
  const workspace = foundation.bootstrap?.workspace;
  const activeNav = path.startsWith('/admin/') ? navigationItems.find((item) => item.path === '/admin') ?? defaultNavigationItem : path.startsWith('/workbench') ? navigationItems.find((item) => item.path === '/workbench') ?? defaultNavigationItem : navigationItems.find((item) => item.path === path) ?? defaultNavigationItem;
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
              : workbenchRoute.kind === 'settings'
                ? '基础设置'
                : workbenchRoute.kind === 'knowledge-import'
                  ? '导入知识'
                  : path.startsWith('/workbench')
                    ? '店铺工作台'
                : path.startsWith('/live-test/')
                  ? '实时联调'
                : path === '/buyer-simulator'
                  ? '买家模拟器'
                  : path === '/scenario-lab'
                    ? '场景实验室'
                    : activeNav.label;
  const token = readWorkspaceSessionToken(sessionKind) ?? '';
  const liveTestShopId = path.startsWith('/live-test/') ? decodeURIComponent(path.slice('/live-test/'.length)) : '';
  const socketLabel = socketStatus === 'connected' ? '实时已连接' : socketStatus === 'connecting' ? '正在连接' : socketStatus === 'disconnected' ? '等待重连' : '未连接';

  return (
    <AppShell activePath={path} activeShopId={activeShopId} isResetting={isResetting || foundation.status === 'loading'} onNavigate={guardedNavigate} onReset={guardedReset} onShopChange={guardedShopChange} onTraceToggle={() => setTraceOpen((value) => !value)} routeTitle={routeTitle} shops={shops} socketLabel={socketLabel} socketReady={socketStatus === 'connected'} traceOpen={traceOpen} workspaceId={workspace?.id}>
      {foundation.status === 'error' ? <FoundationError message={foundation.error} onRetry={() => void loadFoundation()} /> : foundation.status !== 'ready' || !token ? <section className="loading-screen panel-surface"><span className="loading-spinner" /><h2>正在准备 Workspace</h2><p>读取店铺、权限与实时连接…</p></section> : workbenchRoute.kind === 'settings' ? <ShopSettingsPage onDirtyChange={handleSettingsDirtyChange} onNavigate={guardedNavigate} token={token} shops={shops} shopId={workbenchRoute.shopId} refreshKey={snapshotVersion} /> : workbenchRoute.kind === 'knowledge-import' ? <KnowledgeImportPage token={token} shops={shops} shopId={workbenchRoute.shopId} /> : path.startsWith('/workbench') ? <WorkbenchPage token={token} shops={shops} activeShopId={workbenchRoute.kind === 'shop' ? workbenchRoute.shopId : activeShopId} onShopChange={setActiveShopId} onFoundationRefresh={refreshFoundation} refreshKey={snapshotVersion} realtimeEvent={realtimeEvent} traceOpen={traceOpen} onTraceOpen={() => setTraceOpen(true)} onTraceClose={() => setTraceOpen(false)} /> : path.startsWith('/live-test/') ? <LiveTestPage token={token} shops={shops} activeShopId={activeShopId} requestedShopId={liveTestShopId} onShopChange={(shopId) => { setActiveShopId(shopId); navigate(`/live-test/${encodeURIComponent(shopId)}`); }} refreshKey={snapshotVersion} realtimeEvent={realtimeEvent} socketStatus={socketStatus} onOpenWorkbench={(shopId) => navigate(shopId ? `/workbench/shops/${encodeURIComponent(shopId)}` : '/workbench')} /> : path === '/buyer-simulator' ? <BuyerSimulatorPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin' ? <DashboardPage token={token} shops={shops} refreshKey={snapshotVersion} /> : path === '/admin/shops' ? <ShopsAdminPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} onFoundationRefresh={refreshFoundation} /> : path === '/admin/products' ? <ProductLearningPage token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/knowledge' || path === '/admin/knowledge/candidates' || path === '/admin/knowledge/conflicts' ? <KnowledgePage initialView={path === '/admin/knowledge/candidates' ? 'candidates' : path === '/admin/knowledge/conflicts' ? 'conflicts' : 'formal'} token={token} shops={shops} activeShopId={activeShopId} onShopChange={setActiveShopId} refreshKey={snapshotVersion} /> : path === '/admin/workflows' ? <WorkflowAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/quality' ? <QualityPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/incidents' ? <IncidentPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/usage' ? <UsageAdminPage token={token} refreshKey={snapshotVersion} /> : path === '/admin/privacy' ? <DataPrivacyPage token={token} /> : path === '/scenario-lab' ? <ScenarioLabPage token={token} refreshKey={snapshotVersion} /> : <PendingRoute path={path} bootstrap={foundation.bootstrap} />}
    </AppShell>
  );
}
