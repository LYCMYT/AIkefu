import { AlertTriangle, Check, CheckCircle2, Circle, DatabaseZap, FlaskConical, ShieldCheck, Sparkles } from 'lucide-react';
import type { DeveloperTrace } from '../../api';
import type { ShowcaseRunUpdate } from './showcase-runner';
import { projectRecordingTrace, recordingProgress, recordingTraceDetails } from './showcase-recording';

export function ShowcaseRecordingStatus({ selectedIndex, title, total, run }: {
  selectedIndex: number;
  title: string;
  total: number;
  run: ShowcaseRunUpdate;
}) {
  const progress = recordingProgress(selectedIndex, total, run);
  return <section aria-label="录制进度" className={`showcase-recording-status is-${run.status.toLowerCase()}`}>
    <span>{progress.scene}</span>
    <strong>{title}</strong>
    <b>{progress.step}</b>
    <small>{progress.detail}</small>
  </section>;
}

export function ShowcaseRecordingTrace({ trace }: { trace?: DeveloperTrace }) {
  const rows = projectRecordingTrace(trace);
  return <section aria-label="录制技术证据" className="showcase-recording-trace">
    <header><span><DatabaseZap aria-hidden="true" size={17} />DEVELOPER TRACE</span><strong>从消息到发送回执</strong><small>仅展示结构化脱敏元数据</small></header>
    <div className="recording-trace-list">
      {rows.map((row, index) => <article className={`recording-trace-row is-${row.state}`} key={row.key}>
        <span className="recording-trace-index">{row.state === 'done' ? <Check aria-hidden="true" size={13} /> : <Circle aria-hidden="true" size={10} />}</span>
        <div><strong>{row.label}</strong><small>{row.summary}</small></div>
        {row.payload && <details><summary aria-label={`查看 ${row.label} 脱敏详情`}>详情</summary><pre>{JSON.stringify(recordingTraceDetails(row.key, row.payload), null, 2)}</pre></details>}
        {index < rows.length - 1 && <i aria-hidden="true" />}
      </article>)}
    </div>
    <footer><ShieldCheck aria-hidden="true" size={15} />不展示 Prompt、API Key、PII 或模型私有推理</footer>
  </section>;
}

export function ShowcaseClosingFrame({ providerMode, providerLabel }: {
  providerMode: 'REAL' | 'OFFLINE' | 'UNAVAILABLE';
  providerLabel: string;
}) {
  const displayedProvider = providerMode === 'REAL' && providerLabel === 'DeepSeek'
    ? 'DeepSeek（服务端配置）'
    : providerLabel;
  return <section aria-labelledby="showcase-closing-title" className="showcase-closing-frame">
    <span className="showcase-closing-mark"><Sparkles aria-hidden="true" size={32} /></span>
    <p>AIKEFU</p>
    <h2 id="showcase-closing-title">有依据时自动处理，不确定时安全交给人。</h2>
    <div className="showcase-closing-pillars"><span>{displayedProvider}</span><span>Hybrid RAG</span><span>Human-in-the-loop</span><span>Reliable Messaging</span></div>
    <small>MockDouyinAdapter · Synthetic Data · Frozen Eval ≠ Open-domain Accuracy</small>
  </section>;
}

/** Recording-only presentation of a repository-backed regression. The facts
 * are locked by E017 plus the deterministic evaluator/provider regression
 * tests; this card never presents them as live production metrics. */
export function ShowcaseQualityRegression() {
  return <section aria-labelledby="quality-regression-title" className="showcase-quality-regression">
    <header>
      <span><FlaskConical aria-hidden="true" size={17} />仓库回归证据 · E017</span>
      <h2 id="quality-regression-title">不是只看通过率，也要验证 evaluator 自己</h2>
      <p>同一问题经过确定性安全门禁，错误的“相关但不回答问题”回复必须失败。</p>
    </header>
    <div className="quality-regression-flow">
      <article className="is-question"><span>QUESTION</span><strong>你们支持线下试穿吗？</strong><small>Frozen Eval · NO_EVIDENCE</small></article>
      <article className="is-failure"><span><AlertTriangle aria-hidden="true" size={14} />旧失败样本</span><strong>“支持7天无理由退货，但商品需保持完好。”</strong><small>合法知识片段，但没有回答线下试穿</small></article>
      <article className="is-gate"><span><ShieldCheck aria-hidden="true" size={14} />DETERMINISTIC GATE</span><strong>NO_EVIDENCE_EXPECTED</strong><strong>USER_QUESTION_NOT_ANSWERED</strong><small>AI Judge 不能覆盖硬失败</small></article>
      <article className="is-current"><span><CheckCircle2 aria-hidden="true" size={14} />CURRENT SAFE RESULT</span><strong>关于“线下试穿”，暂时没有找到可靠依据，已转入人工确认。</strong><small>ASSIST · WAITING_HUMAN · 不自动发送</small></article>
    </div>
    <footer>证据源：seed/eval-cases.json · reply-eval-runner.spec.ts · ai-providers.spec.ts</footer>
  </section>;
}
