import { Check, Circle, DatabaseZap, ShieldCheck, Sparkles } from 'lucide-react';
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
    <p>AIKEFU · DEMO COMPLETE</p>
    <h2 id="showcase-closing-title">让每一次 AI 回复都可追踪、可降级、可恢复</h2>
    <div className="showcase-closing-pillars"><span>Evidence 驱动</span><span>Human-in-the-loop</span><span>Durable Recovery</span></div>
    <dl><div><dt>模型</dt><dd>{displayedProvider}</dd></div><div><dt>平台</dt><dd>MockDouyin</dd></div><div><dt>数据</dt><dd>合成演示数据</dd></div><div><dt>图片</dt><dd>Pipeline Fixture</dd></div></dl>
    <small>作品集演示环境，不连接真实电商平台，不执行真实退款或订单操作。</small>
  </section>;
}
