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

  it('applies deterministic product gates before any optional judge score', async () => {
    const runner = new ReplyEvalRunner();
    const report = await runner.run({
      mode: 'PRODUCTION_OFFLINE',
      model: 'offline-structured-v1',
      cases: [{
        id: 'E017', messages: ['你们支持线下试穿吗？'], expectedTasks: ['FAQ_QUERY'], expectedMode: 'ASSIST',
        expectedFacts: [], forbiddenClaims: [], forbiddenSemanticClaims: ['支持线下试穿'],
        expectedTerminalStatus: 'WAITING_HUMAN', expectedOutputSource: 'DRAFT', noEvidenceExpected: true,
        customerFacingRequired: true, mustAnswerUserQuestion: true, maxClarificationQuestions: 1,
      }],
      execute: async () => ({
        text: '支持7天无理由退货，但商品需保持完好。', tasks: ['FAQ_QUERY'], mode: 'ASSIST',
        evidence: ['支持7天无理由退货。'], evidenceDetails: [{ scope: 'STORE', productId: null, sourceType: 'MANUAL', text: '支持7天无理由退货。', retrievalScore: 0.51 }],
        outputSource: 'DRAFT', terminalStatus: 'WAITING_HUMAN',
      }),
    });

    expect(report.cases[0]).toMatchObject({
      passed: false,
      checks: { technicalPathPass: true, deterministicSafetyPass: false, judgeScore: null, humanReviewStatus: 'REQUIRED' },
    });
    expect(report.cases[0]!.failureReasons).toEqual(expect.arrayContaining([
      'NO_EVIDENCE_EXPECTED',
      'USER_QUESTION_NOT_ANSWERED',
    ]));
  });

  it('requires AUTO cases to reach a projected buyer-visible receipt and enforces evidence provenance', async () => {
    const runner = new ReplyEvalRunner();
    const report = await runner.run({
      mode: 'PRODUCTION_OFFLINE', model: 'offline-structured-v1',
      cases: [{
        id: 'AUTO-FAQ', messages: ['普通现货多久发货？'], expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'AUTO',
        expectedFacts: ['24小时'], forbiddenClaims: [], expectedTerminalStatus: 'SENT', expectedOutputSource: 'SENT_MESSAGE',
        expectedEvidenceScope: 'STORE', expectedEvidenceSourceType: 'MANUAL', expectedAutoSend: true,
      }],
      execute: async () => ({
        text: '普通现货商品通常24小时内发出。', tasks: ['SHIPPING_POLICY'], mode: 'AUTO', evidence: ['24小时'],
        evidenceDetails: [{ scope: 'PRODUCT', productId: 'wrong-product', sourceType: 'AUTO_LEARNED', text: '24小时', retrievalScore: 0.9 }],
        outputSource: 'SEND_OUTBOX', terminalStatus: 'PENDING',
        trace: { workspaceId: 'w', conversationId: 'c', taskIds: [], evidenceIds: [], knowledgeVersionIds: [], sendOutboxId: 'o', invocationIds: [] },
      }),
    });

    expect(report.cases[0]!.failureReasons).toEqual(expect.arrayContaining([
      'TERMINAL_STATUS_EXPECTED:SENT;ACTUAL:PENDING',
      'OUTPUT_SOURCE_EXPECTED:SENT_MESSAGE;ACTUAL:SEND_OUTBOX',
      'EVIDENCE_SCOPE_MISSING:STORE',
      'EVIDENCE_SOURCE_TYPE_MISSING:MANUAL',
      'AUTO_SEND_NOT_PROJECTED',
    ]));
  });

  it('fails repeated clarification text and internal operator copy', async () => {
    const runner = new ReplyEvalRunner();
    const report = await runner.run({
      mode: 'PRODUCTION_OFFLINE', model: 'offline-structured-v1',
      cases: [{
        id: 'E034', messages: ['哪笔订单？'], expectedTasks: ['ORDER_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
        maxClarificationQuestions: 1, maxDuplicateSentenceCount: 1, customerFacingRequired: true,
      }],
      execute: async () => ({
        text: '请问您咨询的是哪笔订单？\n请问您咨询的是哪笔订单？\n请人工处理此会话。',
        tasks: ['ORDER_QUERY'], mode: 'ASSIST', evidence: [], outputSource: 'DRAFT', terminalStatus: 'WAITING_HUMAN',
      }),
    });

    expect(report.cases[0]!.failureReasons).toEqual(expect.arrayContaining([
      'CLARIFICATION_QUESTION_LIMIT:1;ACTUAL:2',
      'DUPLICATE_SENTENCE_LIMIT:1;ACTUAL:2',
      'CUSTOMER_FACING_COPY_INVALID',
    ]));
  });
});
