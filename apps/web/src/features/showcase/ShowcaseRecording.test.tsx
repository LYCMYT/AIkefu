import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeveloperTrace } from '../../api';
import {
  ShowcaseClosingFrame,
  ShowcaseQualityRegression,
  ShowcaseRecordingStatus,
  ShowcaseRecordingTrace,
} from './ShowcaseRecording';

const trace: DeveloperTrace = {
  traceId: 'trace-recording',
  events: [
    { id: 'event-1', traceId: 'trace-recording', stage: 'REPLY_POLICY', createdAt: '2026-08-31T05:00:00.000Z', payload: { mode: 'MANUAL', reasons: ['HIGH_RISK'], prompt: 'must never render' } },
  ],
};

describe('Showcase recording UI', () => {
  it('renders a compact status strip from the real run update', () => {
    const html = renderToStaticMarkup(<ShowcaseRecordingStatus selectedIndex={1} title="连续消息与多轮上下文" total={6} run={{ status: 'RUNNING', message: '正在聚合 3 条买家消息' }} />);
    expect(html).toContain('SCENE 02 / 06');
    expect(html).toContain('链路执行中');
    expect(html).toContain('正在聚合 3 条买家消息');
    expect(html).toContain('连续消息与多轮上下文');
  });

  it('renders seven honest trace rows with guard and receipt merged', () => {
    const html = renderToStaticMarkup(<ShowcaseRecordingTrace trace={trace} />);
    expect((html.match(/recording-trace-row/g) ?? [])).toHaveLength(7);
    expect(html).toContain('Policy');
    expect(html).toContain('SendGuard / Receipt');
    expect(html).toContain('MANUAL 策略已决策');
    expect(html).toContain('<details');
    expect(html).not.toContain('must never render');
  });

  it('renders DeepSeek on the closing frame only for the real provider projection', () => {
    const realHtml = renderToStaticMarkup(<ShowcaseClosingFrame providerLabel="DeepSeek" providerMode="REAL" />);
    const offlineHtml = renderToStaticMarkup(<ShowcaseClosingFrame providerLabel="离线演示模式" providerMode="OFFLINE" />);
    for (const label of ['有依据时自动处理，不确定时安全交给人。', 'Hybrid RAG', 'Human-in-the-loop', 'Reliable Messaging', 'Synthetic Data', 'MockDouyinAdapter', 'Frozen Eval ≠ Open-domain Accuracy']) expect(realHtml).toContain(label);
    expect(realHtml).toContain('DeepSeek（服务端配置）');
    expect(offlineHtml).toContain('离线演示模式');
    expect(offlineHtml).not.toContain('DeepSeek');
    expect(`${realHtml}${offlineHtml}`).not.toMatch(/准确率|真实抖音已连接|生产已上线/);
  });

  it('gives every catalog scenario a stable recording selector', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/showcase/ShowcasePage.tsx'), 'utf8');
    expect(source).toContain('data-scenario-id={entry.id}');
  });

  it('renders the E017 repository regression without presenting it as a live KPI', () => {
    const html = renderToStaticMarkup(<ShowcaseQualityRegression />);
    for (const value of [
      '你们支持线下试穿吗？',
      '支持7天无理由退货，但商品需保持完好。',
      'NO_EVIDENCE_EXPECTED',
      'USER_QUESTION_NOT_ANSWERED',
      '暂时没有找到可靠依据',
      'E017',
    ]) expect(html).toContain(value);
    expect(html).toContain('仓库回归证据');
    expect(html).not.toMatch(/准确率|实时通过率|线上指标/);
  });

  it('keeps every quality-card claim anchored in the frozen eval and regression test', () => {
    const evalSource = readFileSync(resolve(process.cwd(), '../../seed/eval-cases.json'), 'utf8');
    const regressionSource = readFileSync(resolve(process.cwd(), '../../apps/api/test/reply-eval-runner.spec.ts'), 'utf8');
    const providerSource = readFileSync(resolve(process.cwd(), '../../apps/api/test/ai-providers.spec.ts'), 'utf8');
    expect(evalSource).toContain('"id": "E017"');
    expect(evalSource).toContain('你们支持线下试穿吗？');
    expect(regressionSource).toContain('支持7天无理由退货，但商品需保持完好。');
    expect(regressionSource).toContain('NO_EVIDENCE_EXPECTED');
    expect(regressionSource).toContain('USER_QUESTION_NOT_ANSWERED');
    expect(providerSource).toContain('暂时没有找到可靠依据，已转入人工确认。');
  });
});
