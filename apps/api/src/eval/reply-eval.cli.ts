import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateStructuredOutput } from '@ai-customer-service/core';

import { createServerAiRuntime } from '../ai/ai-providers';
import { getPromptDefinition } from '../ai/prompt-registry';
import { ReplyEvalRunner, type ReplyEvalCase, type ReplyEvalExecution } from './reply-eval-runner';

type EvalFile = { version: string; cases: ReplyEvalCase[] };
type IntentPlan = { tasks: Array<{ intent: string; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; requiredContext: string[]; requiredKnowledge?: string[]; requiredTools: string[] }> };
type RiskResult = { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' };
type ReplyGeneration = { text: string; requiresHuman: boolean };

async function main(): Promise<void> {
  const realProvider = process.argv.includes('--real-provider');
  const offlineFixture = process.argv.includes('--offline-fixture');
  if (realProvider === offlineFixture) throw new Error('Choose exactly one of --real-provider or --offline-fixture');
  if (realProvider && !process.env.AI_PROVIDER?.trim()) throw new Error('AI_PROVIDER is required for --real-provider');

  const sourcePath = resolve(process.cwd(), 'seed/eval-cases.json');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as EvalFile;
  if (!Array.isArray(source.cases) || source.cases.length !== 36) {
    throw new Error(`Expected exactly 36 fixed eval cases, received ${source.cases?.length ?? 0}`);
  }

  const runtime = createServerAiRuntime(process.env);
  const runner = new ReplyEvalRunner();
  const mode = realProvider ? 'REAL_PROVIDER' as const : 'OFFLINE_FIXTURE' as const;
  const report = await runner.run({
    mode,
    provider: realProvider ? process.env.AI_PROVIDER : 'offline-structured-demo',
    model: realProvider ? configuredModel() : 'offline-structured-v1',
    cases: source.cases,
    execute: async (testCase) => executeCase(runtime, testCase),
  });

  const outputDirectory = resolve(process.cwd(), 'artifacts/eval');
  mkdirSync(outputDirectory, { recursive: true });
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const baseName = `reply-eval-${mode.toLowerCase()}-${timestamp}`;
  const json = `${JSON.stringify({ sourceVersion: source.version, ...report }, null, 2)}\n`;
  const markdown = `${runner.toMarkdown(report)}\n`;
  for (const [name, content] of [
    [`${baseName}.json`, json], [`${baseName}.md`, markdown],
    [`reply-eval-${mode.toLowerCase()}-latest.json`, json], [`reply-eval-${mode.toLowerCase()}-latest.md`, markdown],
  ] as const) writeFileSync(resolve(outputDirectory, name), content, 'utf8');

  process.stdout.write(`${mode}: ${report.summary.passed}/${report.summary.total} passed; ${report.summary.failed} failed\n`);
  process.stdout.write(`Reports: artifacts/eval/${baseName}.{json,md}\n`);
  // An eval report with failed cases is a valid diagnostic artifact. CI may
  // opt into strict behavior explicitly; local real-model runs must still
  // persist the complete report for triage.
  if (process.argv.includes('--fail-on-regression') && report.summary.failed > 0) process.exitCode = 2;
}

async function executeCase(
  runtime: ReturnType<typeof createServerAiRuntime>,
  testCase: ReplyEvalCase,
): Promise<ReplyEvalExecution> {
  const startedAt = Date.now();
  const normalizedMessages = testCase.messages.map(renderMessage);
  const turn = normalizedMessages.at(-1) ?? '';
  const intent = await runtime.runStructured<IntentPlan>({
    purpose: 'INTENT_PLANNER',
    input: { turn: { text: turn }, recentMessages: normalizedMessages.slice(-12), contextSetup: testCase.contextSetup ?? {} },
    prompt: getPromptDefinition('INTENT_PLANNER', 'reply-intent-plan-v1'),
    validate: (value): value is IntentPlan => validateStructuredOutput('IntentPlan', value),
  });
  const risk = await runtime.runStructured<RiskResult>({
    purpose: 'RISK_CLASSIFIER',
    input: { tasks: intent.output.tasks.map((task) => ({ intent: task.intent, riskLevel: task.riskLevel })) },
    prompt: getPromptDefinition('RISK_CLASSIFIER', 'reply-risk-v1'),
    validate: (value): value is RiskResult => validateStructuredOutput('RiskResult', value),
  });
  const reply = await runtime.runStructured<ReplyGeneration>({
    purpose: 'REPLY_GENERATION',
    input: {
      turn: { text: turn },
      recentMessages: normalizedMessages.slice(-12),
      tasks: intent.output.tasks,
      contextSetup: testCase.contextSetup ?? {},
      evidence: [],
    },
    prompt: getPromptDefinition('REPLY_GENERATION', 'reply-composer-v1'),
    validate: (value): value is ReplyGeneration => validateStructuredOutput('ReplyGeneration', value),
  });
  const usage = [intent, risk, reply].map((entry) => entry.usage);
  return {
    text: reply.output.text,
    tasks: intent.output.tasks.map((task) => task.intent),
    mode: risk.output.recommendedMode,
    evidence: [],
    provider: reply.provider,
    model: reply.model,
    inputTokens: usage.reduce((sum, entry) => sum + (entry?.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, entry) => sum + (entry?.outputTokens ?? 0), 0),
    latencyMs: Date.now() - startedAt,
    cost: null,
  };
}

function renderMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value ?? '');
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'STRUCTURED_MESSAGE';
  const reference = ['productKey', 'orderKey', 'imageFixture'].map((key) => record[key]).find((entry) => typeof entry === 'string');
  return reference ? `[${type}:${reference}]` : `[${type}]`;
}

function configuredModel(): string {
  return process.env.AI_MODEL_NAME?.trim()
    || process.env.AI_QUALITY_MODEL?.trim()
    || process.env.AI_FAST_MODEL?.trim()
    || 'configured-model';
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
