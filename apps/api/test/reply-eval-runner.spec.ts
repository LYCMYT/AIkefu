import { ReplyEvalRunner } from '../src/eval/reply-eval-runner';

describe('ReplyEvalRunner', () => {
  it('reports every case and never turns executor failures into PASS', async () => {
    const runner = new ReplyEvalRunner();
    const report = await runner.run({
      mode: 'OFFLINE_FIXTURE',
      model: 'offline-structured-v1',
      cases: [
        { id: 'E001', messages: ['多久发货？'], expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'ASSIST', expectedFacts: ['24小时'], forbiddenClaims: ['保证'] },
        { id: 'E002', messages: ['退款'], expectedTasks: ['REFUND_REQUEST'], expectedMode: 'MANUAL', expectedFacts: [], forbiddenClaims: ['已退款'] },
      ],
      execute: async (testCase) => {
        if (testCase.id === 'E002') throw new Error('fixture unavailable');
        return { text: '普通现货商品通常24小时内发出。', tasks: ['SHIPPING_POLICY'], mode: 'ASSIST', evidence: ['knowledge-1'], inputTokens: 3, outputTokens: 5, latencyMs: 12, cost: null };
      },
    });

    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(report.cases[1]).toMatchObject({ id: 'E002', passed: false, failureReasons: ['EXECUTOR_FAILED: fixture unavailable'] });
    expect(runner.toMarkdown(report)).toContain('| E002 | FAIL |');
  });
});
