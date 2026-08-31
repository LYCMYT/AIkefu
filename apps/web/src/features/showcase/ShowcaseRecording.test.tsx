import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeveloperTrace } from '../../api';
import {
  ShowcaseClosingFrame,
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

  it('renders eight honest trace rows with collapsed allowlisted details', () => {
    const html = renderToStaticMarkup(<ShowcaseRecordingTrace trace={trace} />);
    expect((html.match(/recording-trace-row/g) ?? [])).toHaveLength(8);
    expect(html).toContain('Policy');
    expect(html).toContain('MANUAL 策略已决策');
    expect(html).toContain('<details');
    expect(html).not.toContain('must never render');
  });

  it('renders DeepSeek on the closing frame only for the real provider projection', () => {
    const realHtml = renderToStaticMarkup(<ShowcaseClosingFrame providerLabel="DeepSeek" providerMode="REAL" />);
    const offlineHtml = renderToStaticMarkup(<ShowcaseClosingFrame providerLabel="离线演示模式" providerMode="OFFLINE" />);
    for (const label of ['Evidence 驱动', 'Human-in-the-loop', 'Durable Recovery', '合成演示数据', 'MockDouyin']) expect(realHtml).toContain(label);
    expect(realHtml).toContain('DeepSeek（服务端配置）');
    expect(offlineHtml).toContain('离线演示模式');
    expect(offlineHtml).not.toContain('DeepSeek');
    expect(`${realHtml}${offlineHtml}`).not.toMatch(/准确率|真实抖音已连接|生产已上线/);
  });

  it('gives every catalog scenario a stable recording selector', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/showcase/ShowcasePage.tsx'), 'utf8');
    expect(source).toContain('data-scenario-id={entry.id}');
  });
});
