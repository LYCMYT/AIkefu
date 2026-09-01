import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpenCheck, Bot, Braces, CheckCircle2, Play, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { getShowcaseCatalog, type DeveloperTrace, type ShopSummary, type ShowcaseCatalog, type ShowcaseRunStatus } from '../../api';
import type { WorkspaceSocketEvent, WorkspaceSocketStatus } from '../../workspace-socket';
import { LiveTestPage } from '../live-test/LiveTestPage';
import { ShowcaseClosingFrame, ShowcaseQualityRegression, ShowcaseRecordingStatus, ShowcaseRecordingTrace } from './ShowcaseRecording';
import { parseShowcaseRecordingQuery, showcaseRecordingClasses } from './showcase-recording';
import { createShowcaseRunnerPort, runShowcaseScenario, type ShowcaseRunUpdate } from './showcase-runner';
import './showcase.css';

export interface ShowcasePageProps {
  token: string;
  shops: ShopSummary[];
  activeShopId: string;
  onShopChange: (shopId: string) => void;
  onFoundationRefresh: () => Promise<void>;
  onNavigateProduct: (shopId?: string) => void;
  onResetWorkspace: () => void;
  refreshKey: number;
  realtimeEvent?: WorkspaceSocketEvent;
  socketStatus: WorkspaceSocketStatus;
}

const statusCopy: Record<ShowcaseRunStatus, string> = {
  NOT_STARTED: '等待开始', PREPARING: '正在恢复场景', RUNNING: '正在执行真实业务链路', WAITING_AI: 'AI 正在处理',
  WAITING_HUMAN: '等待人工确认', COMPLETED: '场景已完成', FAILED: '场景未完成', CANCELLED: '场景已取消',
};

export function ShowcasePage(props: ShowcasePageProps) {
  const recording = parseShowcaseRecordingQuery(window.location.search);
  const HeroHeading = recording.enabled ? 'h1' : 'h2';
  const [catalog, setCatalog] = useState<ShowcaseCatalog>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [run, setRun] = useState<ShowcaseRunUpdate>({ status: 'NOT_STARTED', message: statusCopy.NOT_STARTED });
  const [trace, setTrace] = useState<DeveloperTrace>();
  const [traceOpen, setTraceOpen] = useState(false);
  const [error, setError] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const traceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const traceCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let current = true;
    setError('');
    void getShowcaseCatalog(props.token).then((next) => {
      if (current) setCatalog(next);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : '无法读取演示场景。');
    });
    return () => { current = false; };
  }, [props.token]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!traceOpen) return;
    traceCloseRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTraceOpen(false);
      window.setTimeout(() => traceTriggerRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [traceOpen]);

  const scenario = catalog?.scenarios[selectedIndex];
  const requestedBuyerExternalId = useMemo(() => catalog?.resources.buyers.find((entry) => entry.key === scenario?.buyerKey)?.externalBuyerId, [catalog, scenario?.buyerKey]);
  const requestedShop = useMemo(() => catalog?.resources.shops.find((entry) => entry.key === scenario?.shopKey), [catalog, scenario?.shopKey]);
  const requestedShopId = props.shops.find((shop) => shop.name === requestedShop?.name)?.id ?? props.activeShopId;
  const busy = ['PREPARING', 'RUNNING', 'WAITING_AI', 'WAITING_HUMAN'].includes(run.status);

  const selectScenario = useCallback((index: number) => {
    if (!catalog || busy) return;
    setSelectedIndex(Math.min(Math.max(index, 0), catalog.scenarios.length - 1));
    setRun({ status: 'NOT_STARTED', message: statusCopy.NOT_STARTED });
    setTrace(undefined);
    setTraceOpen(false);
    setError('');
  }, [busy, catalog]);

  const start = useCallback(async () => {
    if (!catalog || !scenario || busy || catalog.providerMode === 'UNAVAILABLE') return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError('');
    setTrace(undefined);
    const port = createShowcaseRunnerPort(props.token);
    const reset = port.reset;
    port.reset = async () => {
      const bootstrap = await reset();
      const shopName = catalog.resources.shops.find((entry) => entry.key === scenario.shopKey)?.name;
      const shopId = bootstrap.shops.find((shop) => shop.name === shopName)?.id;
      if (shopId) props.onShopChange(shopId);
      await props.onFoundationRefresh();
      setLocalRefresh((value) => value + 1);
      return bootstrap;
    };
    try {
      const result = await runShowcaseScenario(port, catalog, scenario, setRun, controller.signal);
      setTrace(result.trace);
      setLocalRefresh((value) => value + 1);
      await props.onFoundationRefresh();
    } catch (reason) {
      if (controller.signal.aborted) {
        setRun({ status: 'CANCELLED', message: statusCopy.CANCELLED });
        return;
      }
      const message = reason instanceof Error ? reason.message : '场景执行失败。';
      setError(message);
      setRun({ status: 'FAILED', message });
    }
  }, [busy, catalog, props, scenario]);

  const resetShowcase = useCallback(() => {
    controllerRef.current?.abort();
    setRun({ status: 'NOT_STARTED', message: statusCopy.NOT_STARTED });
    setTrace(undefined);
    setTraceOpen(false);
    setError('');
    props.onResetWorkspace();
  }, [props]);

  if (error && !catalog) return <section className="showcase-load-error" role="alert"><strong>无法打开引导演示</strong><p>{error}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></section>;
  if (!catalog || !scenario) return <section className="showcase-loading" aria-busy="true"><span className="loading-spinner" /><strong>正在准备引导演示</strong></section>;
  const providerLabel = catalog.providerMode === 'REAL' ? 'DeepSeek' : catalog.providerMode === 'OFFLINE' ? '显式离线模式' : '真实模型未配置';
  if (recording.closing) return <section className={`${showcaseRecordingClasses(recording)} is-closing`}><ShowcaseClosingFrame providerMode={catalog.providerMode} providerLabel={providerLabel} /></section>;

  return (
    <section className={showcaseRecordingClasses(recording)}>
      <header className="showcase-hero">
        <div><span className="showcase-kicker"><Sparkles aria-hidden="true" size={14} />{recording.enabled ? 'AIKEFU · LIVE SHOWCASE' : 'GUIDED SHOWCASE'}</span><HeroHeading>多店铺电商 AI 客服与 Agent 协同平台</HeroHeading><p>结合企业知识、商品与订单上下文，实现有据回复、人工协同与可靠消息处理。</p></div>
        <div className="showcase-boundaries" aria-label="演示运行边界">
          <span className={`showcase-mode is-${catalog.providerMode.toLowerCase()}`}>{catalog.providerMode === 'REAL' ? (recording.enabled ? `${providerLabel} · 真实模型` : '真实模型') : providerLabel}</span>
          <span>Mock 电商平台</span><span>全部合成数据</span>
          {catalog.multimodalMode === 'FIXTURE' && <span className="is-fixture">图片场景：Fixture</span>}
        </div>
      </header>

      <section className="showcase-values" aria-label="核心能力">
        <article><BookOpenCheck aria-hidden="true" /><div><strong>有据回答</strong><span>知识可追溯，库存与订单读取实时上下文。</span></div></article>
        <article><Bot aria-hidden="true" /><div><strong>人机协同</strong><span>依据风险、证据和店铺策略决定 AUTO / ASSIST / MANUAL。</span></div></article>
        <article><ShieldCheck aria-hidden="true" /><div><strong>可靠执行</strong><span>Stale、SendGuard、Outbox 与 Recovery 防止错发和重复发送。</span></div></article>
      </section>

      <nav aria-label="演示场景" className="showcase-scenarios">
        {catalog.scenarios.map((entry, index) => <button aria-current={index === selectedIndex ? 'step' : undefined} className={index === selectedIndex ? 'is-active' : ''} data-scenario-id={entry.id} disabled={busy} key={entry.id} onClick={() => selectScenario(index)} type="button"><span>{index + 1}</span><strong>{entry.title}</strong></button>)}
      </nav>

      {recording.enabled && recording.focus !== 'quality' && <ShowcaseRecordingStatus selectedIndex={selectedIndex} title={scenario.title} total={catalog.scenarios.length} run={run} />}

      <section className="showcase-runbar" aria-live="polite">
        <div><span className={`showcase-run-status is-${run.status.toLowerCase()}`}>{statusCopy[run.status]}</span><strong>场景 {selectedIndex + 1}/{catalog.scenarios.length} · {scenario.title}</strong><p>{run.message === statusCopy.NOT_STARTED ? scenario.objective : run.message}</p></div>
        <div className="showcase-run-actions">
          <button aria-label="上一个场景" disabled={busy || selectedIndex === 0} onClick={() => selectScenario(selectedIndex - 1)} type="button"><ArrowLeft aria-hidden="true" size={16} />上一场景</button>
          <button className="is-primary" disabled={busy || catalog.providerMode === 'UNAVAILABLE'} onClick={() => void start()} type="button">{busy ? <RefreshCw aria-hidden="true" className="is-spinning" size={16} /> : <Play aria-hidden="true" size={16} />}{run.status === 'COMPLETED' || run.status === 'FAILED' ? '重新运行' : '开始演示'}</button>
          <button aria-label="下一个场景" disabled={busy || selectedIndex === catalog.scenarios.length - 1} onClick={() => selectScenario(selectedIndex + 1)} type="button">下一场景<ArrowRight aria-hidden="true" size={16} /></button>
          <button ref={traceTriggerRef} onClick={() => { setTraceOpen(true); }} disabled={!trace} type="button"><Braces aria-hidden="true" size={16} />技术证据</button>
          <button onClick={resetShowcase} disabled={busy} type="button"><RefreshCw aria-hidden="true" size={16} />重置演示</button>
          <button onClick={() => props.onNavigateProduct(requestedShopId)} type="button">进入完整产品</button>
        </div>
        {catalog.providerMode === 'UNAVAILABLE' && <p className="showcase-provider-error" role="alert">真实模型未配置，生产模式不会静默伪装成离线成功。配置服务端模型，或显式启用 Offline Demo Mode 后再运行。</p>}
        {error && <p className="showcase-run-error" role="alert">{error}</p>}
        {scenario.id === 'SC-04-IMAGE-HUMAN' && catalog.multimodalMode === 'FIXTURE' && <p className="showcase-fixture-note">多模态管线演示（Fixture），用于验证上传、分析、上下文和人工分流，不代表真实视觉准确率。</p>}
      </section>

      {recording.version === 'v2' && recording.focus === 'quality'
        ? <ShowcaseQualityRegression />
        : <div className="showcase-live-surface">
          <LiveTestPage token={props.token} shops={props.shops} activeShopId={props.activeShopId} requestedShopId={requestedShopId} requestedBuyerExternalId={requestedBuyerExternalId} onShopChange={props.onShopChange} refreshKey={props.refreshKey + localRefresh} realtimeEvent={props.realtimeEvent} socketStatus={props.socketStatus} onOpenWorkbench={props.onNavigateProduct} />
        </div>}

      {traceOpen && <div className="showcase-trace-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setTraceOpen(false); window.setTimeout(() => traceTriggerRef.current?.focus(), 0); } }} role="presentation"><aside aria-label="Developer Trace" className={`showcase-trace ${recording.enabled ? 'is-recording-trace' : ''}`} role="dialog" aria-modal="true">{recording.enabled ? <><button className="recording-trace-close" ref={traceCloseRef} aria-label="关闭 Developer Trace" onClick={() => { setTraceOpen(false); window.setTimeout(() => traceTriggerRef.current?.focus(), 0); }} type="button"><X aria-hidden="true" size={18} /></button><ShowcaseRecordingTrace trace={trace} /></> : <><header><div><span>DEVELOPER TRACE</span><strong>真实技术证据</strong></div><button ref={traceCloseRef} aria-label="关闭 Developer Trace" onClick={() => { setTraceOpen(false); window.setTimeout(() => traceTriggerRef.current?.focus(), 0); }} type="button"><X aria-hidden="true" size={18} /></button></header><div className="showcase-trace-events">{trace?.events.length ? trace.events.map((event) => <article key={event.id}><span>{event.stage}</span><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</time><pre>{JSON.stringify(event.payload, null, 2)}</pre></article>) : <p>当前会话尚无可展示 Trace。</p>}</div><footer><CheckCircle2 aria-hidden="true" size={15} />仅展示结构化脱敏元数据，不展示 Prompt 或思维链。</footer></>}</aside></div>}
    </section>
  );
}
