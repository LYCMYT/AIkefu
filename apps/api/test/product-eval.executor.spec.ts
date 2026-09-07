import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRODUCT_EVAL_CAPABILITIES } from '../src/eval-v2/product-eval.capabilities';
import {
  ProductEvalExecutor,
  ProductionProductEvalPort,
  toLegacyReplyEvalCase,
  type ProductEvalObservation,
  type ProductEvalPort,
} from '../src/eval-v2/product-eval.executor';
import type { ProductEvalCaseV2 } from '../src/eval-v2/eval-v2.types';

const baseCase: ProductEvalCaseV2 = {
  id: 'K01',
  sourceRow: 2,
  domain: 'Store Knowledge',
  shopKey: 'shop_mia_fashion',
  buyerKey: 'buyer_001',
  messages: [{ type: 'TEXT', text: '今天下单什么时候发货？', turn: 1 }],
  setup: [{ type: 'SET_SHOP_AI_MODE', mode: 'AUTO_ALLOWED' }],
  expected: {
    tasks: ['SHIPPING_POLICY'],
    mode: 'AUTO',
    terminalStatuses: ['SENT'],
    outputSources: ['SENT_MESSAGE', 'SEND_OUTBOX'],
    evidence: { required: true, scopes: ['STORE'], knowledgeKeys: ['k001'], productKeys: [] },
    tools: [],
    requiredFacts: ['普通地区发货政策'],
    forbiddenClaims: ['保证明天到'],
    maxClarificationQuestions: null,
    autoSend: true,
    oldReplyMustNotBeSent: false,
  },
  gateSeverity: 'STANDARD',
  execution: { kind: 'REPLY_RUNTIME', requiredCapabilities: ['TEXT_TURN'] },
  metricTags: ['e2e'],
  notes: [],
};

const passingObservation: ProductEvalObservation = {
  text: '普通地区发货政策为现货商品通常24小时内发出，以物流为准。',
  tasks: ['SHIPPING_POLICY'],
  mode: 'AUTO',
  terminalStatus: 'SENT',
  outputSource: 'SENT_MESSAGE',
  evidence: [{ knowledgeKey: 'k001', scope: 'STORE', productKey: null }],
  tools: [],
  sentOutbox: true,
  projectedMessage: true,
  oldReplySent: false,
};

function factCase(
  fact: string,
  expected: Partial<ProductEvalCaseV2['expected']> = {},
): ProductEvalCaseV2 {
  return {
    ...baseCase,
    expected: {
      ...baseCase.expected,
      tasks: ['INVENTORY_QUERY'],
      mode: 'ASSIST',
      terminalStatuses: ['WAITING_HUMAN'],
      outputSources: ['DRAFT'],
      evidence: { required: false, scopes: [], knowledgeKeys: [], productKeys: [] },
      tools: ['GET_INVENTORY'],
      requiredFacts: [fact],
      forbiddenClaims: [],
      autoSend: null,
      ...expected,
    },
  };
}

function factObservation(
  text: string,
  observation: Partial<ProductEvalObservation> = {},
): ProductEvalObservation {
  return {
    ...passingObservation,
    text,
    tasks: ['INVENTORY_QUERY'],
    mode: 'ASSIST',
    terminalStatus: 'WAITING_HUMAN',
    outputSource: 'DRAFT',
    evidence: [],
    tools: ['GET_INVENTORY'],
    sentOutbox: false,
    projectedMessage: false,
    ...observation,
  };
}

function port(overrides: Partial<ProductEvalPort> = {}): ProductEvalPort {
  return {
    capabilities: new Set(PRODUCT_EVAL_CAPABILITIES),
    execute: async () => passingObservation,
    ...overrides,
  };
}

describe('ProductEvalExecutor', () => {
  it('recognizes every capability emitted by the committed canonical suite', () => {
    const canonical = JSON.parse(readFileSync(
      resolve(__dirname, '../../../evals/canonical/product-testset-72.v2.json'),
      'utf8',
    )) as { cases: ProductEvalCaseV2[] };
    const required = new Set(canonical.cases.flatMap((entry) => entry.execution.requiredCapabilities));

    expect(canonical.cases).toHaveLength(72);
    expect([...required].filter((entry) => !PRODUCT_EVAL_CAPABILITIES.includes(entry as never))).toEqual([]);
  });

  it('reports an unsupported required capability instead of silently passing', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_017);
    const result = await new ProductEvalExecutor(port({ capabilities: new Set(['TEXT_TURN']) }))
      .execute({ ...baseCase, execution: { kind: 'RELIABILITY_HARNESS', requiredCapabilities: ['TEXT_TURN', 'RESTART_SENDING'] } }, 'OFFLINE_FIXTURE');

    now.mockRestore();

    expect(result).toMatchObject({
      id: 'K01',
      status: 'BLOCKED_UNSUPPORTED',
      passed: false,
      durationMs: 17,
      failureReasons: ['UNSUPPORTED_CAPABILITY:RESTART_SENDING'],
    });
  });

  it('does not pass AUTO without both a sent outbox and projected buyer-visible message', async () => {
    const result = await new ProductEvalExecutor(port({
      execute: async () => ({ ...passingObservation, outputSource: 'SEND_OUTBOX', projectedMessage: false }),
    })).execute(baseCase, 'OFFLINE_FIXTURE');

    expect(result.status).toBe('FAIL');
    expect(result.failureReasons).toContain('AUTO_PROJECTED_MESSAGE_MISSING');
  });

  it('fails closed when a MANUAL case emits an AI send', async () => {
    const testCase: ProductEvalCaseV2 = {
      ...baseCase,
      expected: {
        ...baseCase.expected,
        mode: 'MANUAL',
        terminalStatuses: ['WAITING_HUMAN'],
        outputSources: ['DRAFT', 'NONE'],
        autoSend: false,
      },
    };
    const result = await new ProductEvalExecutor(port({
      execute: async () => ({
        ...passingObservation,
        mode: 'MANUAL',
        terminalStatus: 'WAITING_HUMAN',
        sentOutbox: true,
        projectedMessage: true,
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(result.status).toBe('FAIL');
    expect(result.failureReasons).toEqual(expect.arrayContaining([
      'OUTPUT_SOURCE_EXPECTED:DRAFT|NONE;ACTUAL:SENT_MESSAGE',
      'MANUAL_AI_SEND_FORBIDDEN',
    ]));
  });

  it('checks tasks, frozen evidence, tools, facts and forbidden claims before passing', async () => {
    const result = await new ProductEvalExecutor(port()).execute(baseCase, 'OFFLINE_FIXTURE');

    expect(result).toMatchObject({
      id: 'K01',
      status: 'PASS',
      passed: true,
      providerMode: 'OFFLINE_FIXTURE',
      failureReasons: [],
    });
  });

  it('recognizes a grounded ordinary-region shipping policy without requiring the evaluator label verbatim', async () => {
    const grounded = await new ProductEvalExecutor(port({
      execute: async () => ({
        ...passingObservation,
        text: '普通现货商品通常在24小时内发出；预售商品以商品说明为准。',
      }),
    })).execute(baseCase, 'OFFLINE_FIXTURE');
    const labelEcho = await new ProductEvalExecutor(port({
      execute: async () => ({ ...passingObservation, text: '普通地区发货政策。' }),
    })).execute(baseCase, 'OFFLINE_FIXTURE');

    expect(grounded.status).toBe('PASS');
    expect(labelEcho.failureReasons).toContain('FACT_MISSING:普通地区发货政策');
  });

  it('does not turn a selected product context into a knowledge evidence requirement', async () => {
    const testCase: ProductEvalCaseV2 = {
      ...baseCase,
      expected: {
        ...baseCase.expected,
        evidence: {
          required: false,
          scopes: [],
          knowledgeKeys: [],
          productKeys: ['fashion_hoodie'],
        },
      },
    };

    const result = await new ProductEvalExecutor(port({
      execute: async () => ({ ...passingObservation, evidence: [] }),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(result.status).toBe('PASS');
    expect(result.failureReasons).not.toContain('EVIDENCE_PRODUCT_MISSING:fashion_hoodie');
  });

  it('accepts a product clarification for I04 but rejects a guessed stock answer disguised as a question', async () => {
    const testCase = factCase('不能猜商品');
    const guessed = await new ProductEvalExecutor(port({
      execute: async () => factObservation('轻薄连帽卫衣有现货，请问是这款吗？'),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(await new ProductEvalExecutor(port({
      execute: async () => factObservation('请发送具体商品卡或商品名称，我再帮您查询库存。'),
    })).execute(testCase, 'OFFLINE_FIXTURE')).toMatchObject({ status: 'PASS' });
    expect(await new ProductEvalExecutor(port({
      execute: async () => factObservation('请问您咨询的是哪件商品？ 可选：柔软针织开衫、短款轻羽绒服。'),
    })).execute(testCase, 'OFFLINE_FIXTURE')).toMatchObject({ status: 'PASS' });
    expect(guessed.failureReasons).toContain('FACT_MISSING:不能猜商品');
  });

  it('permits a no-evidence weight comparison only as a safe clarification, never a number or meta-label echo', async () => {
    const testCase = factCase('只比较有Evidence的重量', {
      tasks: ['PRODUCT_QUERY'],
      tools: ['GET_PRODUCT'],
      forbiddenClaims: ['编造重量数字'],
    });
    const clarification = await new ProductEvalExecutor(port({
      execute: async () => factObservation('目前没有可核实的重量信息，您更关注哪一款的轻便性？', {
        tasks: ['PRODUCT_QUERY'], tools: ['GET_PRODUCT'],
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');
    const inventedWeight = await new ProductEvalExecutor(port({
      execute: async () => factObservation('第一款约 300g，比第二款更轻。', {
        tasks: ['PRODUCT_QUERY'], tools: ['GET_PRODUCT'],
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');
    const labelEcho = await new ProductEvalExecutor(port({
      execute: async () => factObservation('只比较有Evidence的重量', {
        tasks: ['PRODUCT_QUERY'], tools: ['GET_PRODUCT'],
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(clarification.status).toBe('PASS');
    expect(inventedWeight.failureReasons).toContain('FACT_MISSING:只比较有Evidence的重量');
    expect(labelEcho.failureReasons).toContain('FACT_MISSING:只比较有Evidence的重量');
  });

  it('requires I08 to state correct availability for both named colors', async () => {
    const testCase = factCase('两种颜色状态都正确');
    const valid = await new ProductEvalExecutor(port({
      execute: async () => factObservation('黑色目前有货，白色目前也有货。'),
    })).execute(testCase, 'OFFLINE_FIXTURE');
    const wrong = await new ProductEvalExecutor(port({
      execute: async () => factObservation('黑色有货，白色无货。'),
    })).execute(testCase, 'OFFLINE_FIXTURE');
    const vague = await new ProductEvalExecutor(port({
      execute: async () => factObservation('两个颜色都有货。'),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(valid.status).toBe('PASS');
    expect(wrong.failureReasons).toContain('FACT_MISSING:两种颜色状态都正确');
    expect(vague.failureReasons).toContain('FACT_MISSING:两种颜色状态都正确');
  });

  it('requires O02 to ground the explicit order-status wording in live taskDetails', async () => {
    const orderCase: ProductEvalCaseV2 = {
      ...baseCase,
      id: 'O02',
      messages: [
        { type: 'ORDER_CARD', orderKey: 'order_004', turn: 1 },
        { type: 'TEXT', text: '这个订单发货了吗？', turn: 1 },
      ],
      expected: {
        ...baseCase.expected,
        tasks: ['ORDER_QUERY'],
        tools: ['GET_ORDER'],
        evidence: { required: false, scopes: [], knowledgeKeys: [], productKeys: [] },
        requiredFacts: ['状态正确'],
      },
    };
    const observation = (text: string, status?: string, taskStatus = 'RESOLVED'): ProductEvalObservation => ({
      ...passingObservation,
      text,
      tasks: ['ORDER_QUERY'],
      tools: ['GET_ORDER'],
      taskDetails: status === undefined ? undefined : [{
        intent: 'ORDER_QUERY',
        status: taskStatus,
        result: { context: { dynamic: { status } } },
      }],
    });

    const valid = await new ProductEvalExecutor(port({
      execute: async () => observation('这笔订单目前已经完成。', 'COMPLETED'),
    })).execute(orderCase, 'OFFLINE_FIXTURE');
    const wrongStatus = await new ProductEvalExecutor(port({
      execute: async () => observation('这笔订单目前已经完成。', 'WAITING_SHIPMENT'),
    })).execute(orderCase, 'OFFLINE_FIXTURE');
    const missingLiveStatus = await new ProductEvalExecutor(port({
      execute: async () => observation('这笔订单目前已经完成。'),
    })).execute(orderCase, 'OFFLINE_FIXTURE');
    const vague = await new ProductEvalExecutor(port({
      execute: async () => observation('这笔订单目前有最新进展。', 'COMPLETED'),
    })).execute(orderCase, 'OFFLINE_FIXTURE');
    const failedTask = await new ProductEvalExecutor(port({
      execute: async () => observation('这笔订单目前已经完成。', 'COMPLETED', 'FAILED'),
    })).execute(orderCase, 'OFFLINE_FIXTURE');

    expect(valid.status).toBe('PASS');
    expect(wrongStatus.failureReasons).toContain('FACT_MISSING:状态正确');
    expect(missingLiveStatus.failureReasons).toContain('FACT_MISSING:状态正确');
    expect(vague.failureReasons).toContain('FACT_MISSING:状态正确');
    expect(failedTask.failureReasons).toContain('FACT_MISSING:状态正确');
  });

  it('passes R03/R04 only for a grounded abstention with no attached evidence or send', async () => {
    const testCase = factCase('无相关Evidence不触发回答', {
      tasks: ['UNKNOWN'],
      mode: 'MANUAL',
      tools: ['TRANSFER_HUMAN'],
      autoSend: false,
    });
    const valid = await new ProductEvalExecutor(port({
      execute: async () => factObservation('暂时没有找到可靠依据，已转人工为您确认。', {
        tasks: ['UNKNOWN'], mode: 'MANUAL', tools: ['TRANSFER_HUMAN'],
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');
    const metaLabel = await new ProductEvalExecutor(port({
      execute: async () => factObservation('无相关Evidence不触发回答', {
        tasks: ['UNKNOWN'], mode: 'MANUAL', tools: ['TRANSFER_HUMAN'],
      }),
    })).execute(testCase, 'OFFLINE_FIXTURE');

    expect(valid.status).toBe('PASS');
    expect(metaLabel.failureReasons).toContain('FACT_MISSING:无相关Evidence不触发回答');
  });

  it('requires white-SKU answers to mention white availability and excludes stale black content', async () => {
    const whiteCase = factCase('回答白色条件');
    const onlyWhiteCase = factCase('只回答白色', { oldReplyMustNotBeSent: true });

    expect(await new ProductEvalExecutor(port({
      execute: async () => factObservation('白色目前有货。'),
    })).execute(whiteCase, 'OFFLINE_FIXTURE')).toMatchObject({ status: 'PASS' });
    expect((await new ProductEvalExecutor(port({
      execute: async () => factObservation('黑色目前有货。'),
    })).execute(whiteCase, 'OFFLINE_FIXTURE')).failureReasons).toContain('FACT_MISSING:回答白色条件');
    expect((await new ProductEvalExecutor(port({
      execute: async () => factObservation('黑色和白色目前都有货。'),
    })).execute(onlyWhiteCase, 'OFFLINE_FIXTURE')).failureReasons).toContain('FACT_MISSING:只回答白色');
  });

  it('keeps environmental failures distinct from product failures', async () => {
    const result = await new ProductEvalExecutor(port({
      execute: async () => { throw new Error('EVAL_ENVIRONMENT_UNAVAILABLE:postgres'); },
    })).execute(baseCase, 'REAL_PROVIDER');

    expect(result).toMatchObject({
      status: 'BLOCKED_ENVIRONMENT',
      passed: false,
      failureReasons: ['EVAL_ENVIRONMENT_UNAVAILABLE:postgres'],
      providerMode: 'REAL_PROVIDER',
    });
  });

  it('runs every case and preserves a result row even when one execution throws', async () => {
    const cases = [baseCase, { ...baseCase, id: 'K02' }];
    const executor = new ProductEvalExecutor(port({
      execute: async (testCase) => {
        if (testCase.id === 'K02') throw new Error('unexpected');
        return passingObservation;
      },
    }));

    const results = await executor.run(cases, 'OFFLINE_FIXTURE');

    expect(results).toHaveLength(2);
    expect(results.map((entry) => [entry.id, entry.status])).toEqual([
      ['K01', 'PASS'],
      ['K02', 'FAIL'],
    ]);
    expect(results[1]?.failureReasons).toEqual(['EXECUTOR_FAILED:unexpected']);
  });
});

describe('ProductionProductEvalPort', () => {
  it('adapts structured cards, setup actions, and exact expectations without parsing control text', () => {
    const adapted = toLegacyReplyEvalCase({
      ...baseCase,
      messages: [
        { type: 'GOODS_CARD', productKey: 'fashion_hoodie', turn: 1 },
        { type: 'TEXT', text: '这个能烘干吗？', turn: 1 },
      ],
      setup: [
        { type: 'SET_SHOP_AI_MODE', mode: 'ASSIST_ONLY' },
        { type: 'ACTIVATE_CONFLICT', fixtureKey: 'conflict_001' },
        { type: 'RESTART_DURING', phase: 'GENERATING' },
      ],
    });

    expect(adapted).toMatchObject({
      id: 'K01',
      shopKey: 'shop_mia_fashion',
      buyerKey: 'buyer_001',
      messages: [
        { type: 'GOODS_CARD', productKey: 'fashion_hoodie', turn: 1 },
        { type: 'TEXT', text: '这个能烘干吗？', turn: 1 },
      ],
      contextSetup: {
        shopAiMode: 'ASSIST_ONLY',
        activateConflict: 'conflict_001',
        restartDuring: 'GENERATING',
      },
      expectedTasks: ['SHIPPING_POLICY'],
      expectedMode: 'AUTO',
    });
  });

  it('projects production output into V2 evidence/tool/send observations', async () => {
    const execute = jest.fn(async () => ({
      text: passingObservation.text,
      tasks: ['SHIPPING_POLICY'],
      mode: 'AUTO',
      evidence: ['ordinary policy'],
      evidenceDetails: [{
        scope: 'STORE', productId: null, sourceType: 'MANUAL', text: 'ordinary policy', retrievalScore: 0.9,
        knowledgeKey: 'k001', productKey: null,
      }],
      tools: [],
      outputSource: 'SENT_MESSAGE' as const,
      terminalStatus: 'SENT',
      trace: {
        workspaceId: 'workspace', conversationId: 'conversation', replyJobId: 'job', userTurnId: 'turn',
        taskIds: ['task'], evidenceIds: ['evidence'], knowledgeVersionIds: ['version'],
        sendOutboxId: 'outbox', sentMessageId: 'message', invocationIds: [],
      },
      oldReplySent: false,
    }));
    const adapter = new ProductionProductEvalPort({ execute });

    const actual = await adapter.execute(baseCase, 'OFFLINE_FIXTURE');

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'K01' }));
    expect(actual).toMatchObject({
      evidence: [{ knowledgeKey: 'k001', scope: 'STORE', productKey: null }],
      tools: [], sentOutbox: true, projectedMessage: true, oldReplySent: false,
    });
  });

  it('fails closed when an old-reply safety case has no durable send audit', async () => {
    const execute = jest.fn(async () => ({
      text: '已根据最新状态处理。',
      tasks: ['INVENTORY_QUERY'],
      mode: 'ASSIST',
      evidence: [],
      tools: ['GET_INVENTORY'],
      outputSource: 'DRAFT' as const,
      terminalStatus: 'WAITING_HUMAN',
    }));
    const adapter = new ProductionProductEvalPort({ execute });
    const auditedCase = {
      ...baseCase,
      expected: { ...baseCase.expected, oldReplyMustNotBeSent: true },
    };

    await expect(adapter.execute(auditedCase, 'OFFLINE_FIXTURE')).rejects.toThrow('OLD_REPLY_AUDIT_MISSING');
  });
});
