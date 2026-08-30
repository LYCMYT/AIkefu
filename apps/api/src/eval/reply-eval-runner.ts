export type ReplyEvalCase = {
  id: string;
  category?: string;
  shopKey?: string;
  buyerKey?: string;
  messages: unknown[];
  contextSetup?: Record<string, unknown>;
  expectedTasks: string[];
  expectedMode: string;
  expectedFacts: string[];
  forbiddenClaims: string[];
  expectedTerminalStatus?: string | string[];
  expectedOutputSource?: NonNullable<ReplyEvalExecution['outputSource']> | NonNullable<ReplyEvalExecution['outputSource']>[];
  expectedEvidenceScope?: string | string[];
  expectedEvidenceProductId?: string | string[];
  expectedEvidenceSourceType?: string | string[];
  maxClarificationQuestions?: number;
  maxDuplicateSentenceCount?: number;
  mustAnswerUserQuestion?: boolean;
  noEvidenceExpected?: boolean;
  customerFacingRequired?: boolean;
  expectedAutoSend?: boolean;
  forbiddenSemanticClaims?: string[];
  notes?: string;
};

export type ReplyEvalExecution = {
  text: string;
  tasks: string[];
  mode: string;
  evidence: string[];
  evidenceDetails?: Array<{
    scope: string;
    productId: string | null;
    sourceType: string;
    text: string;
    retrievalScore: number | null;
  }>;
  outputSource?: 'SENT_MESSAGE' | 'SEND_OUTBOX' | 'DRAFT' | 'TASK_RESULT' | 'NONE';
  terminalStatus?: string;
  trace?: {
    workspaceId: string;
    conversationId: string;
    replyJobId?: string;
    userTurnId?: string;
    taskIds: string[];
    evidenceIds: string[];
    knowledgeVersionIds: string[];
    draftId?: string;
    sendOutboxId?: string;
    sentMessageId?: string;
    invocationIds: string[];
  };
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  cost?: number | null;
};

export type ReplyEvalCaseResult = ReplyEvalExecution & {
  id: string;
  passed: boolean;
  failureReasons: string[];
  checks: {
    technicalPathPass: boolean;
    deterministicSafetyPass: boolean;
    judgeScore: number | null;
    humanReviewStatus: 'NOT_REQUIRED' | 'REQUIRED';
  };
};

export type ReplyEvalReport = {
  generatedAt: string;
  mode: 'OFFLINE_FIXTURE' | 'REAL_PROVIDER' | 'PRODUCTION_OFFLINE' | 'PRODUCTION_REAL_PROVIDER';
  provider?: string;
  model: string;
  summary: { total: number; passed: number; failed: number; technicalPathPassed: number; deterministicSafetyPassed: number; humanReviewRequired: number; inputTokens: number; outputTokens: number; totalCost: number | null; averageLatencyMs: number };
  cases: ReplyEvalCaseResult[];
};

export class ReplyEvalRunner {
  async run(input: {
    mode: ReplyEvalReport['mode'];
    provider?: string;
    model: string;
    cases: readonly ReplyEvalCase[];
    execute(testCase: ReplyEvalCase): Promise<ReplyEvalExecution>;
  }): Promise<ReplyEvalReport> {
    const results: ReplyEvalCaseResult[] = [];
    for (const testCase of input.cases) {
      try {
        const execution = await input.execute(testCase);
        const failureReasons = evaluateCase(testCase, execution);
        const checks = qualityChecks(failureReasons);
        results.push({ id: testCase.id, ...execution, passed: failureReasons.length === 0, failureReasons, checks });
      } catch (error) {
        results.push({
          id: testCase.id, text: '', tasks: [], mode: 'NOT_RUN', evidence: [],
          provider: input.provider, model: input.model, inputTokens: 0, outputTokens: 0, latencyMs: 0, cost: null,
          passed: false, failureReasons: [`EXECUTOR_FAILED: ${error instanceof Error ? error.message : String(error)}`],
          checks: { technicalPathPass: false, deterministicSafetyPass: false, judgeScore: null, humanReviewStatus: 'REQUIRED' },
        });
      }
    }
    const knownCosts = results.map((entry) => entry.cost).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return {
      generatedAt: new Date().toISOString(), mode: input.mode, provider: input.provider, model: input.model,
      summary: {
        total: results.length,
        passed: results.filter((entry) => entry.passed).length,
        failed: results.filter((entry) => !entry.passed).length,
        technicalPathPassed: results.filter((entry) => entry.checks.technicalPathPass).length,
        deterministicSafetyPassed: results.filter((entry) => entry.checks.deterministicSafetyPass).length,
        humanReviewRequired: results.filter((entry) => entry.checks.humanReviewStatus === 'REQUIRED').length,
        inputTokens: sum(results.map((entry) => entry.inputTokens ?? 0)),
        outputTokens: sum(results.map((entry) => entry.outputTokens ?? 0)),
        totalCost: knownCosts.length === results.length ? sum(knownCosts) : null,
        averageLatencyMs: results.length ? Math.round(sum(results.map((entry) => entry.latencyMs ?? 0)) / results.length) : 0,
      },
      cases: results,
    };
  }

  toMarkdown(report: ReplyEvalReport): string {
    const lines = [
      '# AIkefu Reply Eval Report',
      '',
      `- Generated: ${report.generatedAt}`,
      `- Mode: ${report.mode}`,
      `- Provider / model: ${report.provider ?? 'n/a'} / ${report.model}`,
      `- Result: ${report.summary.passed}/${report.summary.total} passed; ${report.summary.failed} failed`,
      `- Technical path: ${report.summary.technicalPathPassed}/${report.summary.total} passed`,
      `- Deterministic safety: ${report.summary.deterministicSafetyPassed}/${report.summary.total} passed`,
      `- Human review required: ${report.summary.humanReviewRequired}`,
      `- Tokens: ${report.summary.inputTokens} input / ${report.summary.outputTokens} output`,
      `- Average latency: ${report.summary.averageLatencyMs} ms`,
      `- Cost: ${report.summary.totalCost === null ? 'not reported' : report.summary.totalCost}`,
      '',
      '| Case | Result | Technical | Safety | Human review | Mode | Tasks | Evidence | Failure |',
      '|---|---|---|---|---|---|---|---|---|',
      ...report.cases.map((entry) => `| ${cell(entry.id)} | ${entry.passed ? 'PASS' : 'FAIL'} | ${entry.checks.technicalPathPass ? 'PASS' : 'FAIL'} | ${entry.checks.deterministicSafetyPass ? 'PASS' : 'FAIL'} | ${entry.checks.humanReviewStatus} | ${cell(entry.mode)} | ${cell(entry.tasks.join(', '))} | ${cell(entry.evidence.join(', '))} | ${cell(entry.failureReasons.join('; '))} |`),
    ];
    return lines.join('\n');
  }
}

function evaluateCase(testCase: ReplyEvalCase, actual: ReplyEvalExecution): string[] {
  const reasons: string[] = [];
  for (const task of testCase.expectedTasks) if (!actual.tasks.includes(task)) reasons.push(`TASK_MISSING:${task}`);
  if (testCase.expectedMode && actual.mode !== testCase.expectedMode) reasons.push(`MODE_EXPECTED:${testCase.expectedMode};ACTUAL:${actual.mode}`);
  for (const fact of testCase.expectedFacts) if (!actual.text.includes(fact)) reasons.push(`FACT_MISSING:${fact}`);
  for (const claim of testCase.forbiddenClaims) if (claim && actual.text.includes(claim)) reasons.push(`FORBIDDEN_CLAIM:${claim}`);
  for (const claim of testCase.forbiddenSemanticClaims ?? []) {
    if (claim && semanticClaimMatches(actual.text, claim)) reasons.push(`FORBIDDEN_SEMANTIC_CLAIM:${claim}`);
  }
  if (testCase.expectedTerminalStatus) {
    const expected = values(testCase.expectedTerminalStatus);
    if (!actual.terminalStatus || !expected.includes(actual.terminalStatus)) reasons.push(`TERMINAL_STATUS_EXPECTED:${expected.join('|')};ACTUAL:${actual.terminalStatus ?? 'NONE'}`);
  }
  if (testCase.expectedOutputSource) {
    const expected = values(testCase.expectedOutputSource);
    if (!actual.outputSource || !expected.includes(actual.outputSource)) reasons.push(`OUTPUT_SOURCE_EXPECTED:${expected.join('|')};ACTUAL:${actual.outputSource ?? 'NONE'}`);
  }
  checkEvidenceExpectation(reasons, 'SCOPE', testCase.expectedEvidenceScope, actual.evidenceDetails?.map((entry) => entry.scope) ?? []);
  checkEvidenceExpectation(reasons, 'PRODUCT_ID', testCase.expectedEvidenceProductId, actual.evidenceDetails?.flatMap((entry) => entry.productId ? [entry.productId] : []) ?? []);
  checkEvidenceExpectation(reasons, 'SOURCE_TYPE', testCase.expectedEvidenceSourceType, actual.evidenceDetails?.map((entry) => entry.sourceType) ?? []);
  if (testCase.noEvidenceExpected && (actual.evidence.length > 0 || (actual.evidenceDetails?.length ?? 0) > 0)) reasons.push('NO_EVIDENCE_EXPECTED');
  const clarificationQuestions = countClarificationQuestions(actual.text);
  if (testCase.maxClarificationQuestions !== undefined && clarificationQuestions > testCase.maxClarificationQuestions) {
    reasons.push(`CLARIFICATION_QUESTION_LIMIT:${testCase.maxClarificationQuestions};ACTUAL:${clarificationQuestions}`);
  }
  const duplicateCount = maximumDuplicateSentenceCount(actual.text);
  if (testCase.maxDuplicateSentenceCount !== undefined && duplicateCount > testCase.maxDuplicateSentenceCount) {
    reasons.push(`DUPLICATE_SENTENCE_LIMIT:${testCase.maxDuplicateSentenceCount};ACTUAL:${duplicateCount}`);
  }
  if (testCase.customerFacingRequired && !isCustomerFacing(actual.text)) reasons.push('CUSTOMER_FACING_COPY_INVALID');
  if (testCase.mustAnswerUserQuestion && !answersUserQuestion(testCase, actual.text)) reasons.push('USER_QUESTION_NOT_ANSWERED');
  if (testCase.expectedAutoSend === true && !(
    actual.mode === 'AUTO'
    && actual.outputSource === 'SENT_MESSAGE'
    && actual.terminalStatus === 'SENT'
    && Boolean(actual.trace?.sendOutboxId)
    && Boolean(actual.trace?.sentMessageId)
  )) reasons.push('AUTO_SEND_NOT_PROJECTED');
  if (testCase.expectedAutoSend === false && (actual.outputSource === 'SENT_MESSAGE' || actual.terminalStatus === 'SENT')) reasons.push('AUTO_SEND_UNEXPECTED');
  if (!actual.text.trim()) reasons.push('EMPTY_REPLY');
  return reasons;
}

const TECHNICAL_REASON_PREFIXES = [
  'EXECUTOR_FAILED', 'TASK_MISSING', 'MODE_EXPECTED', 'TERMINAL_STATUS_EXPECTED', 'OUTPUT_SOURCE_EXPECTED',
  'EVIDENCE_SCOPE_MISSING', 'EVIDENCE_PRODUCT_ID_MISSING', 'EVIDENCE_SOURCE_TYPE_MISSING', 'AUTO_SEND_NOT_PROJECTED',
];

function qualityChecks(failureReasons: readonly string[]): ReplyEvalCaseResult['checks'] {
  const technicalPathPass = !failureReasons.some((reason) => TECHNICAL_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)));
  const deterministicSafetyPass = failureReasons.length === 0;
  return {
    technicalPathPass,
    deterministicSafetyPass,
    judgeScore: null,
    humanReviewStatus: deterministicSafetyPass ? 'NOT_REQUIRED' : 'REQUIRED',
  };
}

function values<T extends string>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? [...value] : [value as T];
}

function checkEvidenceExpectation(reasons: string[], label: string, expected: string | string[] | undefined, actual: readonly string[]): void {
  if (!expected) return;
  for (const value of values(expected)) if (!actual.includes(value)) reasons.push(`EVIDENCE_${label}_MISSING:${value}`);
}

function countClarificationQuestions(text: string): number {
  return (text.match(/[？?]/gu) ?? []).length;
}

function maximumDuplicateSentenceCount(text: string): number {
  const counts = new Map<string, number>();
  for (const sentence of text.split(/[。！？!?\n]+/u).map((entry) => normalizeSemantic(entry)).filter(Boolean)) {
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function isCustomerFacing(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized === '请人工处理此会话。') return false;
  return !/(?:reply[_ -]?job|send[_ -]?outbox|trace[_ -]?id|WAITING_HUMAN|MANUAL_REQUIRED|NO_EVIDENCE|\{\s*"|请人工处理此会话)/iu.test(normalized);
}

function answersUserQuestion(testCase: ReplyEvalCase, text: string): boolean {
  if (/(?:暂时没有找到|没有足够|无法确认|还需要人工确认|转入人工确认|需要人工进一步确认)/u.test(text)) return true;
  const source = [...testCase.messages].reverse().find((message): message is string => typeof message === 'string') ?? '';
  const terms = meaningfulSemanticTerms(source);
  if (!terms.length) return Boolean(text.trim());
  const normalizedAnswer = normalizeSemantic(text);
  return terms.some((term) => normalizedAnswer.includes(term));
}

function semanticClaimMatches(text: string, claim: string): boolean {
  const normalizedText = normalizeSemantic(text);
  const normalizedClaim = normalizeSemantic(claim);
  if (normalizedText.includes(normalizedClaim)) return true;
  const terms = meaningfulSemanticTerms(normalizedClaim);
  return terms.length > 0 && terms.filter((term) => normalizedText.includes(term)).length / terms.length >= 0.8;
}

function meaningfulSemanticTerms(value: string): string[] {
  const normalized = normalizeSemantic(value);
  const han = [...normalized.replace(/[^\u3400-\u9fff]/g, '')];
  const bigrams = Array.from({ length: Math.max(0, han.length - 1) }, (_, index) => `${han[index]}${han[index + 1]}`);
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  return [...new Set([...latin, ...bigrams])].filter((term) => !['你们', '我们', '请问', '是否', '可以', '支持', '这个', '那个', '的吗'].includes(term));
}

function normalizeSemantic(value: string): string {
  return value.toLocaleLowerCase()
    .replace(/(?:穿什么码|穿多大码|什么尺码)/gu, '尺码')
    .replace(/到店|门店/gu, '线下')
    .replace(/退换/gu, '退货')
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’()（）\[\]{}]/gu, '');
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
