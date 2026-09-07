import type {
  EvalCaseStatus,
  EvalProviderMode,
  ProductEvalCaseV2,
} from './eval-v2.types';
import type { ReplyEvalCase, ReplyEvalExecution } from '../eval/reply-eval-runner';
import type { ProductionReplyEvalExecutor } from '../eval/production-reply-eval-executor';
import { PRODUCT_EVAL_CAPABILITIES } from './product-eval.capabilities';

export type ProductEvalObservation = {
  text: string;
  tasks: string[];
  mode: 'AUTO' | 'ASSIST' | 'MANUAL' | string;
  terminalStatus: string;
  outputSource: ProductEvalCaseV2['expected']['outputSources'][number];
  evidence: Array<{
    knowledgeKey: string;
    scope: 'STORE' | 'PRODUCT';
    productKey: string | null;
  }>;
  tools: string[];
  taskDetails?: Array<{ intent: string; status: string; result: unknown }>;
  sentOutbox: boolean;
  projectedMessage: boolean;
  oldReplySent: boolean;
  clarificationQuestions?: number;
  traceId?: string;
};

export type ProductEvalPort = {
  capabilities: ReadonlySet<string>;
  execute(testCase: ProductEvalCaseV2, providerMode: EvalProviderMode): Promise<ProductEvalObservation>;
};

export type ProductEvalCaseResultV2 = {
  id: string;
  status: EvalCaseStatus;
  passed: boolean;
  providerMode: EvalProviderMode;
  /** Wall-clock duration of this individual case, including deterministic checks. */
  durationMs: number;
  gateSeverity: ProductEvalCaseV2['gateSeverity'];
  failureReasons: string[];
  observation?: ProductEvalObservation;
};

export class ProductEvalExecutor {
  constructor(private readonly port: ProductEvalPort) {}

  async run(
    cases: readonly ProductEvalCaseV2[],
    providerMode: EvalProviderMode,
  ): Promise<ProductEvalCaseResultV2[]> {
    const results: ProductEvalCaseResultV2[] = [];
    for (const testCase of cases) results.push(await this.execute(testCase, providerMode));
    return results;
  }

  async execute(
    testCase: ProductEvalCaseV2,
    providerMode: EvalProviderMode,
  ): Promise<ProductEvalCaseResultV2> {
    const startedAt = Date.now();
    const duration = () => Math.max(0, Date.now() - startedAt);
    const unsupported = testCase.execution.requiredCapabilities
      .filter((capability) => !this.port.capabilities.has(capability));
    if (unsupported.length) {
      return result(testCase, providerMode, 'BLOCKED_UNSUPPORTED', unsupported.map((value) => `UNSUPPORTED_CAPABILITY:${value}`), duration());
    }

    try {
      const observation = await this.port.execute(testCase, providerMode);
      const failureReasons = evaluateObservation(testCase, observation);
      return {
        ...result(testCase, providerMode, failureReasons.length ? 'FAIL' : 'PASS', failureReasons, duration()),
        observation,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status: EvalCaseStatus = message.startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:')
        ? 'BLOCKED_ENVIRONMENT'
        : message.startsWith('EXECUTOR_UNSUPPORTED:')
          ? 'BLOCKED_UNSUPPORTED'
          : 'FAIL';
      return result(
        testCase,
        providerMode,
        status,
        [status === 'FAIL' ? `EXECUTOR_FAILED:${message}` : message],
        duration(),
      );
    }
  }
}

type LegacyExecutor = Pick<ProductionReplyEvalExecutor, 'execute'>;

/** Bridges canonical V2 cases to the existing production Message→Reply chain. */
export class ProductionProductEvalPort implements ProductEvalPort {
  readonly capabilities: ReadonlySet<string> = new Set(PRODUCT_EVAL_CAPABILITIES);

  constructor(private readonly production: LegacyExecutor) {}

  async execute(testCase: ProductEvalCaseV2, _providerMode: EvalProviderMode): Promise<ProductEvalObservation> {
    const execution = await this.production.execute(toLegacyReplyEvalCase(testCase));
    return observationFromLegacy(execution, testCase.expected.oldReplyMustNotBeSent);
  }
}

export function toLegacyReplyEvalCase(testCase: ProductEvalCaseV2): ReplyEvalCase {
  const contextSetup: Record<string, unknown> = {};
  const selectedProducts: string[] = [];
  const selectedOrders: string[] = [];
  for (const action of testCase.setup) {
    switch (action.type) {
      case 'SET_SHOP_AI_MODE': contextSetup.shopAiMode = action.mode; break;
      case 'SELECT_PRODUCT': selectedProducts.push(action.productKey); break;
      case 'SELECT_ORDER': selectedOrders.push(action.orderKey); break;
      case 'SET_HUMAN_ACTIVE': contextSetup.humanActive = action.value; break;
      case 'ACTIVATE_CONFLICT': contextSetup.activateConflict = action.fixtureKey; break;
      case 'CHANGE_INVENTORY_DURING_GENERATION':
        contextSetup.changeInventoryDuringGeneration = { sku: action.externalSkuId, from: action.from, to: action.to };
        break;
      case 'CHANGE_ORDER_DURING_GENERATION':
        contextSetup.changeOrderDuringGeneration = { orderKey: action.orderKey, to: action.toStatus };
        break;
      case 'CHANGE_LOGISTICS_DURING_GENERATION':
        contextSetup.changeLogisticsDuringGeneration = { orderKey: action.orderKey, toNode: action.toNode };
        break;
      case 'SET_PROVIDER_FAULT': contextSetup.primaryProvider = action.primary; contextSetup.fallback = action.fallback; break;
      case 'RESTART_DURING': contextSetup.restartDuring = action.phase; break;
      case 'SEND_DUPLICATE_TRANSPORT_MESSAGE': contextSetup.duplicateTransport = true; break;
      case 'SEND_OUT_OF_ORDER_TRANSPORT_MESSAGES': contextSetup.outOfOrderTransport = true; break;
    }
  }

  const messages: unknown[] = [
    ...selectedProducts.map((productKey) => ({ type: 'GOODS_CARD', productKey, turn: firstTurn(testCase) })),
    ...selectedOrders.map((orderKey) => ({ type: 'ORDER_CARD', orderKey, turn: firstTurn(testCase) })),
    ...testCase.messages.map(toLegacyMessage),
  ];
  return {
    id: testCase.id,
    category: testCase.domain,
    shopKey: testCase.shopKey,
    buyerKey: testCase.buyerKey,
    messages,
    contextSetup,
    expectedTasks: testCase.expected.tasks,
    expectedMode: testCase.expected.mode,
    expectedFacts: testCase.expected.requiredFacts,
    forbiddenClaims: testCase.expected.forbiddenClaims,
    expectedTerminalStatus: testCase.expected.terminalStatuses,
    expectedOutputSource: testCase.expected.outputSources,
    expectedEvidenceScope: testCase.expected.evidence.scopes,
    maxClarificationQuestions: testCase.expected.maxClarificationQuestions ?? undefined,
    expectedAutoSend: testCase.expected.autoSend ?? undefined,
    noEvidenceExpected: !testCase.expected.evidence.required,
    notes: testCase.notes.join(' '),
  };
}

function toLegacyMessage(message: ProductEvalCaseV2['messages'][number]): unknown {
  switch (message.type) {
    case 'TEXT': return { type: 'TEXT', text: message.text, turn: message.turn };
    case 'GOODS_CARD': return { type: 'GOODS_CARD', productKey: message.productKey, turn: message.turn };
    case 'ORDER_CARD': return { type: 'ORDER_CARD', orderKey: message.orderKey, turn: message.turn };
    case 'IMAGE': return { type: 'IMAGE', fixture: message.fixture, turn: message.turn };
    case 'EDIT_PREVIOUS': return { action: 'EDIT_PREVIOUS', text: message.text, turn: message.turn };
    case 'RECALL_PREVIOUS': return { action: 'RECALL_PREVIOUS', turn: message.turn };
  }
}

function firstTurn(testCase: ProductEvalCaseV2): number {
  return testCase.messages[0]?.turn ?? 1;
}

function observationFromLegacy(execution: ReplyEvalExecution, oldReplyAuditRequired: boolean): ProductEvalObservation {
  if (oldReplyAuditRequired && execution.oldReplySent === undefined) throw new Error('OLD_REPLY_AUDIT_MISSING');
  return {
    text: execution.text,
    tasks: execution.tasks,
    mode: execution.mode,
    terminalStatus: execution.terminalStatus ?? 'NONE',
    outputSource: execution.outputSource ?? 'NONE',
    evidence: (execution.evidenceDetails ?? []).flatMap((entry) => entry.knowledgeKey
      ? [{
          knowledgeKey: entry.knowledgeKey,
          scope: entry.scope as 'STORE' | 'PRODUCT',
          productKey: entry.productKey ?? null,
        }]
      : []),
    tools: execution.tools ?? [],
    taskDetails: execution.taskDetails,
    sentOutbox: Boolean(execution.trace?.sendOutboxId && execution.terminalStatus === 'SENT'),
    projectedMessage: Boolean(execution.trace?.sentMessageId),
    oldReplySent: execution.oldReplySent ?? false,
  };
}

function evaluateObservation(testCase: ProductEvalCaseV2, actual: ProductEvalObservation): string[] {
  const reasons: string[] = [];
  for (const task of testCase.expected.tasks) {
    if (!actual.tasks.includes(task)) reasons.push(`TASK_MISSING:${task}`);
  }
  if (actual.mode !== testCase.expected.mode) {
    reasons.push(`MODE_EXPECTED:${testCase.expected.mode};ACTUAL:${actual.mode}`);
  }
  if (!testCase.expected.terminalStatuses.includes(actual.terminalStatus)) {
    reasons.push(`TERMINAL_STATUS_EXPECTED:${testCase.expected.terminalStatuses.join('|')};ACTUAL:${actual.terminalStatus}`);
  }
  if (!testCase.expected.outputSources.includes(actual.outputSource)) {
    reasons.push(`OUTPUT_SOURCE_EXPECTED:${testCase.expected.outputSources.join('|')};ACTUAL:${actual.outputSource}`);
  }
  for (const fact of testCase.expected.requiredFacts) {
    if (fact && !requiredFactSatisfied(fact, testCase, actual)) reasons.push(`FACT_MISSING:${fact}`);
  }
  for (const claim of testCase.expected.forbiddenClaims) {
    if (claim && actual.text.includes(claim)) reasons.push(`FORBIDDEN_CLAIM:${claim}`);
  }
  if (testCase.expected.evidence.required && actual.evidence.length === 0) reasons.push('EVIDENCE_REQUIRED');
  for (const scope of testCase.expected.evidence.scopes) {
    if (!actual.evidence.some((entry) => entry.scope === scope)) reasons.push(`EVIDENCE_SCOPE_MISSING:${scope}`);
  }
  if (
    testCase.expected.evidence.knowledgeKeys.length > 0
    && !testCase.expected.evidence.knowledgeKeys.some((key) => actual.evidence.some((entry) => entry.knowledgeKey === key))
  ) {
    reasons.push(`EVIDENCE_KNOWLEDGE_MISSING_ANY:${testCase.expected.evidence.knowledgeKeys.join('|')}`);
  }
  if (testCase.expected.evidence.required) {
    for (const key of testCase.expected.evidence.productKeys) {
      if (!actual.evidence.some((entry) => entry.productKey === key)) reasons.push(`EVIDENCE_PRODUCT_MISSING:${key}`);
    }
  }
  for (const tool of testCase.expected.tools) {
    if (!actual.tools.includes(tool)) reasons.push(`TOOL_MISSING:${tool}`);
  }
  const clarificationQuestions = actual.clarificationQuestions ?? countQuestions(actual.text);
  if (
    testCase.expected.maxClarificationQuestions !== null
    && clarificationQuestions > testCase.expected.maxClarificationQuestions
  ) {
    reasons.push(`CLARIFICATION_QUESTION_LIMIT:${testCase.expected.maxClarificationQuestions};ACTUAL:${clarificationQuestions}`);
  }
  if (testCase.expected.oldReplyMustNotBeSent && actual.oldReplySent) reasons.push('OLD_REPLY_WAS_SENT');

  if (testCase.expected.mode === 'AUTO' || testCase.expected.autoSend === true) {
    if (!actual.sentOutbox) reasons.push('AUTO_SENT_OUTBOX_MISSING');
    if (!actual.projectedMessage) reasons.push('AUTO_PROJECTED_MESSAGE_MISSING');
  }
  if (
    testCase.expected.mode === 'MANUAL'
    || testCase.expected.autoSend === false
  ) {
    if (actual.sentOutbox || actual.projectedMessage || actual.outputSource === 'SENT_MESSAGE') {
      reasons.push('MANUAL_AI_SEND_FORBIDDEN');
    }
  }
  return unique(reasons);
}

function result(
  testCase: ProductEvalCaseV2,
  providerMode: EvalProviderMode,
  status: EvalCaseStatus,
  failureReasons: string[],
  durationMs: number,
): ProductEvalCaseResultV2 {
  return {
    id: testCase.id,
    status,
    passed: status === 'PASS',
    providerMode,
    durationMs,
    gateSeverity: testCase.gateSeverity,
    failureReasons,
  };
}

function countQuestions(value: string): number {
  return (value.match(/[?？]/gu) ?? []).length;
}

function requiredFactSatisfied(
  fact: string,
  testCase: ProductEvalCaseV2,
  actual: ProductEvalObservation,
): boolean {
  const text = actual.text;
  const expectedKnowledge = testCase.expected.evidence.knowledgeKeys;
  const evidenceKeys = new Set(actual.evidence.map((entry) => entry.knowledgeKey));
  const evidenceComplete = expectedKnowledge.length > 0 && expectedKnowledge.some((key) => evidenceKeys.has(key));
  const toolsComplete = testCase.expected.tools.every((tool) => actual.tools.includes(tool));
  const tasksComplete = testCase.expected.tasks.every((task) => actual.tasks.includes(task));
  const safelyHeld = !actual.sentOutbox && !actual.projectedMessage && ['ASSIST', 'MANUAL'].includes(actual.mode);
  const allowedTerminal = testCase.expected.terminalStatuses.includes(actual.terminalStatus);
  const noForbiddenLiteral = testCase.expected.forbiddenClaims.every((claim) => !claim || !text.includes(claim));

  if (/不能猜商品/u.test(fact)) {
    const requestsProduct = /(?:请|麻烦).{0,12}(?:商品卡|商品名称|具体商品|哪件商品|哪款|款式)|(?:商品卡|商品名称).{0,8}(?:发送|提供)/u.test(text);
    const guessedAvailability = /(?:有货|现货|可售|无货|缺货|售罄|不可售)/u.test(text);
    return safelyHeld && actual.evidence.length === 0 && requestsProduct && !guessedAvailability;
  }
  if (/只比较有Evidence的重量/u.test(fact)) {
    const metaLabel = text.trim() === fact || /只比较有Evidence的重量/u.test(text);
    const statesWeightNumber = /(?:\d+(?:\.\d+)?\s*(?:g|克|kg|千克)|(?:重量|重)\s*(?:为|是|约)?\s*\d+)/iu.test(text);
    const clarifiesOrHolds = /(?:请问|哪(?:一|个|款)|商品卡|商品名称|没有|暂无|无法确认|更关注)/u.test(text);
    const makesComparison = /(?:更轻|更重|重量)/u.test(text);
    if (actual.evidence.length > 0) return !metaLabel && makesComparison && noForbiddenLiteral;
    return safelyHeld && !metaLabel && !statesWeightNumber && clarifiesOrHolds;
  }
  if (/两种颜色状态都正确/u.test(fact)) {
    const positiveFor = (color: string) => new RegExp(`${color}.{0,16}(?:有货|现货|可售|库存(?:充足|正常)|还有\\d+件)`, 'u').test(text);
    const negativeColor = /(?:黑色|白色).{0,12}(?:无货|缺货|售罄|不可售)/u.test(text);
    return positiveFor('黑色') && positiveFor('白色') && !negativeColor && toolsComplete;
  }
  if (/无相关Evidence不触发回答/u.test(fact)) {
    const noSend = !actual.sentOutbox && !actual.projectedMessage;
    const abstained = text.trim().length === 0
      ? actual.outputSource === 'NONE'
      : /(?:没有|暂无|未找到).{0,12}(?:可靠依据|相关依据|可靠信息)|(?:转|请|由).{0,8}人工.{0,8}(?:确认|核实|处理)/u.test(text);
    return actual.evidence.length === 0
      && actual.mode === 'MANUAL'
      && noSend
      && actual.tools.includes('TRANSFER_HUMAN')
      && abstained;
  }
  if (/回答白色条件|只回答白色/u.test(fact)) {
    const whiteFact = /白色.{0,20}(?:有货|现货|可售|无货|缺货|售罄|库存|还有|剩余)/u.test(text);
    const staleBlack = /只回答白色/u.test(fact) && /黑色/u.test(text);
    return whiteFact && !staleBlack && !actual.oldReplySent && noForbiddenLiteral;
  }
  if (/^状态正确$/u.test(fact)) {
    return orderStatusFactSatisfied(actual);
  }
  if (/^普通地区发货政策$/u.test(fact)) {
    const statesDispatchWindow = /(?:\d+\s*小时|当日|次日|\d+\s*个?工作日)/u.test(text)
      && /(?:发货|发出)/u.test(text);
    const evidenceGrounded = !testCase.expected.evidence.required || evidenceComplete;
    return evidenceGrounded && statesDispatchWindow && noForbiddenLiteral;
  }
  if (actual.text.includes(fact)) return true;

  if (/Top3|知识进入|只命中|Evidence|有据|有依据|政策优先|正确商品事实|准确材质|已知季节|已知版型|店铺政策/u.test(fact)) {
    return evidenceComplete && noForbiddenLiteral;
  }
  if (/库存\+|材质\+|两个问题|两个政策|商品\+订单|都答|漏/u.test(fact)) {
    return tasksComplete && toolsComplete && Boolean(text.trim());
  }
  if (/可售|有货|无货|价格事实|订单|物流|节点|正确顺序|正确承运/u.test(fact)) {
    return toolsComplete && Boolean(text.trim()) && noForbiddenLiteral;
  }
  if (/实际物流|具体到达日期/u.test(fact)) return /(实际物流|物流信息为准|不作固定|无法保证|不能保证)/u.test(text);
  if (/7天无理由及适用条件/u.test(fact)) return /7天无理由/u.test(text) && /(完好|二次销售|条件)/u.test(text);
  if (/不建议烘干/u.test(fact)) return /不建议.*烘干/u.test(text);
  if (/宽松/u.test(fact)) return noForbiddenLiteral && safelyHeld;
  if (/不猜订单/u.test(fact)) {
    return safelyHeld && /(请问|哪个|哪一|发送.*卡|商品名称|人工|确认)/u.test(text);
  }
  if (/无可靠依据|暂无可靠依据|人工确认|转人工|人工\/安全失败|消费者转人工|自然转人工|安全拒绝/u.test(fact)) {
    return safelyHeld && /(人工|可靠依据|核实|确认|无法)/u.test(text);
  }
  if (/未执行前/u.test(fact)) return safelyHeld && noForbiddenLiteral;
  if (/人工接管/u.test(fact)) return actual.mode === 'MANUAL' && !actual.sentOutbox && !actual.projectedMessage;
  if (/只发送新回复|最终仅一份回复|最多一次/u.test(fact)) return !actual.oldReplySent && noForbiddenLiteral;
  if (/按物流问题处理/u.test(fact)) return tasksComplete && noForbiddenLiteral;
  if (/最终状态一致/u.test(fact)) return allowedTerminal;
  if (/消费者文案自然/u.test(fact)) return Boolean(text.trim()) && !/(?:ReplyJob|SendOutbox|WAITING_HUMAN|MANUAL_REQUIRED)/u.test(text);
  return false;
}

const LIVE_ORDER_STATUS_CLAIMS: Record<string, RegExp> = {
  WAITING_SHIPMENT: /(?:待发货|尚未发货|还未发货|未发货|等待发货)/u,
  SHIPPED: /(?:已发货|已经发货|已发出|已经发出|运输中|配送中|派送中)/u,
  COMPLETED: /(?:已完成|已经完成|已签收|已经签收|签收完成)/u,
};

function orderStatusFactSatisfied(actual: ProductEvalObservation): boolean {
  const orderTask = actual.taskDetails?.find((task) => task.intent === 'ORDER_QUERY');
  if (!orderTask || !['RESOLVED', 'COMPLETED'].includes(orderTask.status)) return false;

  const result = jsonRecord(orderTask.result);
  const context = jsonRecord(result.context);
  const dynamic = jsonRecord(context.dynamic);
  const liveStatus = typeof dynamic.status === 'string' ? dynamic.status : undefined;
  const expectedClaim = liveStatus ? LIVE_ORDER_STATUS_CLAIMS[liveStatus] : undefined;
  if (!expectedClaim || !expectedClaim.test(actual.text)) return false;

  return Object.entries(LIVE_ORDER_STATUS_CLAIMS)
    .filter(([status]) => status !== liveStatus)
    .every(([, claim]) => !claim.test(actual.text));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
