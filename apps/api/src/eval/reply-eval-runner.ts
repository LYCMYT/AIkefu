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
  notes?: string;
};

export type ReplyEvalExecution = {
  text: string;
  tasks: string[];
  mode: string;
  evidence: string[];
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
};

export type ReplyEvalReport = {
  generatedAt: string;
  mode: 'OFFLINE_FIXTURE' | 'REAL_PROVIDER' | 'PRODUCTION_OFFLINE' | 'PRODUCTION_REAL_PROVIDER';
  provider?: string;
  model: string;
  summary: { total: number; passed: number; failed: number; inputTokens: number; outputTokens: number; totalCost: number | null; averageLatencyMs: number };
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
        results.push({ id: testCase.id, ...execution, passed: failureReasons.length === 0, failureReasons });
      } catch (error) {
        results.push({
          id: testCase.id, text: '', tasks: [], mode: 'NOT_RUN', evidence: [],
          provider: input.provider, model: input.model, inputTokens: 0, outputTokens: 0, latencyMs: 0, cost: null,
          passed: false, failureReasons: [`EXECUTOR_FAILED: ${error instanceof Error ? error.message : String(error)}`],
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
      `- Tokens: ${report.summary.inputTokens} input / ${report.summary.outputTokens} output`,
      `- Average latency: ${report.summary.averageLatencyMs} ms`,
      `- Cost: ${report.summary.totalCost === null ? 'not reported' : report.summary.totalCost}`,
      '',
      '| Case | Result | Mode | Tasks | Evidence | Failure |',
      '|---|---|---|---|---|---|',
      ...report.cases.map((entry) => `| ${cell(entry.id)} | ${entry.passed ? 'PASS' : 'FAIL'} | ${cell(entry.mode)} | ${cell(entry.tasks.join(', '))} | ${cell(entry.evidence.join(', '))} | ${cell(entry.failureReasons.join('; '))} |`),
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
  if (!actual.text.trim()) reasons.push('EMPTY_REPLY');
  return reasons;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
