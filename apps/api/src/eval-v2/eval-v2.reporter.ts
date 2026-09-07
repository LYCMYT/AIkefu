import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductEvalCaseResultV2 } from './product-eval.executor';
import type { RetrievalEvalCaseResultV2 } from './retrieval-eval.executor';
import type {
  EvalCaseStatus,
  EvalProviderMode,
  ProductEvalCaseV2,
  RetrievalEvalCaseV2,
} from './eval-v2.types';

const STATUSES: readonly EvalCaseStatus[] = [
  'PASS', 'FAIL', 'BLOCKED_UNSUPPORTED', 'BLOCKED_ENVIRONMENT', 'NOT_RUN',
];
const SECRET_FIELD = /(?:api[_-]?key|token|cookie|password|secret|auth|database[_-]?url|redis[_-]?url|connection[_-]?string|s3)/iu;

type EvalV2RunMetadata = {
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
  providerMode: EvalProviderMode;
  providerName?: string;
  model: string;
  git: { commit: string; dirty: boolean };
  environment: { node: string; pnpm: string; os: string };
  sourceHashes: { retrieval: string; product: string };
  canonicalHashes: { retrieval: string; product: string };
  commands: Array<{ command: string; exitCode: number; durationMs: number }>;
};

export type EvalV2ReportInput = {
  run: EvalV2RunMetadata;
  retrieval: { cases: readonly RetrievalEvalCaseV2[]; results: readonly RetrievalEvalCaseResultV2[] };
  product: { cases: readonly ProductEvalCaseV2[]; results: readonly ProductEvalCaseResultV2[] };
};

type StatusCounts = Record<EvalCaseStatus, number>;

export type EvalV2Report = {
  manifest: Record<string, unknown>;
  summary: {
    total: number;
    passed: number;
    statusCounts: StatusCounts;
    retrievalStatusCounts: StatusCounts;
    productStatusCounts: StatusCounts;
    safetyBlockerFailures: string[];
  };
  retrievalResults: unknown[];
  productResults: unknown[];
  coverageMatrix: string;
  markdown: { retrieval: string; product: string };
};

export type WrittenEvalV2Report = {
  directory: string;
  runId: string;
};

/**
 * Produces the strictly allowlisted manifest schema and rejects credential-like
 * keys at any depth before a report reaches disk.
 */
export function sanitizeEvalV2Manifest(value: unknown): Record<string, unknown> {
  rejectSecretFields(value);
  const run = asRecord(value);
  const git = asRecord(run.git);
  const environment = asRecord(run.environment);
  const sourceHashes = asRecord(run.sourceHashes);
  const canonicalHashes = asRecord(run.canonicalHashes);
  const commands = Array.isArray(run.commands) ? run.commands.map((entry) => {
    const command = asRecord(entry);
    return {
      command: stringValue(command.command),
      exitCode: numberValue(command.exitCode),
      durationMs: numberValue(command.durationMs),
    };
  }) : [];
  return {
    startedAt: stringValue(run.startedAt),
    finishedAt: stringValue(run.finishedAt),
    durationMs: numberValue(run.durationMs),
    providerMode: stringValue(run.providerMode),
    providerName: stringValue(run.providerName),
    model: stringValue(run.model),
    git: { commit: stringValue(git.commit), dirty: Boolean(git.dirty) },
    environment: { node: stringValue(environment.node), pnpm: stringValue(environment.pnpm), os: stringValue(environment.os) },
    sourceHashes: { retrieval: stringValue(sourceHashes.retrieval), product: stringValue(sourceHashes.product) },
    canonicalHashes: { retrieval: stringValue(canonicalHashes.retrieval), product: stringValue(canonicalHashes.product) },
    commands,
  };
}

export function buildEvalV2Report(input: EvalV2ReportInput): EvalV2Report {
  const manifest = sanitizeEvalV2Manifest(input.run);
  const retrieval = pairCasesWithResults(input.retrieval.cases, input.retrieval.results, 'retrieval');
  const product = pairCasesWithResults(input.product.cases, input.product.results, 'product');
  const allIds = [...retrieval, ...product].map((entry) => entry.case.id);
  if (new Set(allIds).size !== allIds.length) throw new Error('REPORT_SOURCE_ID_DUPLICATE');

  const retrievalStatusCounts = countStatuses(retrieval.map((entry) => entry.result.status));
  const productStatusCounts = countStatuses(product.map((entry) => entry.result.status));
  const statusCounts = addCounts(retrievalStatusCounts, productStatusCounts);
  const safetyBlockerFailures = product
    .filter((entry) => entry.case.gateSeverity === 'SAFETY_BLOCKER' && entry.result.status !== 'PASS')
    .map((entry) => entry.case.id);

  const summary = {
    total: allIds.length,
    passed: statusCounts.PASS,
    statusCounts,
    retrievalStatusCounts,
    productStatusCounts,
    safetyBlockerFailures,
  };
  const retrievalResults = retrieval.map(({ case: testCase, result }) => ({
    sourceId: testCase.id,
    sourceRow: testCase.sourceRow,
    input: { query: testCase.query, shopKey: testCase.shopKey, productKey: testCase.productKey },
    expectation: testCase.expectation,
    status: result.status,
    providerMode: result.providerMode,
    durationMs: result.durationMs,
    actual: result.actual,
    assertions: result.failureReasons,
  }));
  const productResults = product.map(({ case: testCase, result }) => ({
    sourceId: testCase.id,
    sourceRow: testCase.sourceRow,
    input: testCase.messages,
    setup: testCase.setup,
    expected: testCase.expected,
    execution: testCase.execution,
    gateSeverity: testCase.gateSeverity,
    status: result.status,
    providerMode: result.providerMode,
    durationMs: result.durationMs,
    actual: result.observation ?? null,
    assertions: result.failureReasons,
  }));
  const coverageMatrix = renderCoverageMatrix(retrieval, product);
  return {
    manifest,
    summary,
    retrievalResults,
    productResults,
    coverageMatrix,
    markdown: {
      retrieval: renderMarkdown('Retrieval Eval V2', retrievalStatusCounts, retrievalResults, []),
      product: renderMarkdown('Product Eval V2', productStatusCounts, productResults, safetyBlockerFailures),
    },
  };
}

/** Writes a whole run through a sibling staging directory, then renames it once. */
export function writeEvalV2ReportAtomically(input: EvalV2ReportInput, outputRoot: string): WrittenEvalV2Report {
  const report = buildEvalV2Report(input);
  const runId = runIdFor(input.run.startedAt, input.run.git.commit);
  const destination = join(outputRoot, runId);
  if (existsSync(destination)) throw new Error(`REPORT_RUN_EXISTS:${runId}`);
  mkdirSync(outputRoot, { recursive: true });
  const staging = mkdtempSync(join(outputRoot, '.eval-v2-staging-'));
  try {
    writeJson(join(staging, 'manifest.json'), { ...report.manifest, summary: report.summary });
    writeJson(join(staging, 'retrieval-results.json'), { summary: report.summary.retrievalStatusCounts, cases: report.retrievalResults });
    writeFileSync(join(staging, 'retrieval-report.md'), report.markdown.retrieval, 'utf8');
    writeJson(join(staging, 'product-results.json'), { summary: report.summary.productStatusCounts, cases: report.productResults });
    writeFileSync(join(staging, 'product-report.md'), report.markdown.product, 'utf8');
    writeFileSync(join(staging, 'coverage-matrix.csv'), report.coverageMatrix, 'utf8');
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory: destination, runId };
}

export function escapeEvalV2Csv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function pairCasesWithResults<T extends { id: string }, R extends { id: string; status: EvalCaseStatus }>(
  cases: readonly T[], results: readonly R[], suite: string,
): Array<{ case: T; result: R }> {
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new Error(`REPORT_CASE_ID_DUPLICATE:${suite}:${testCase.id}`);
    ids.add(testCase.id);
  }
  const byId = new Map<string, R>();
  for (const result of results) {
    if (byId.has(result.id)) throw new Error(`REPORT_RESULT_ID_DUPLICATE:${suite}:${result.id}`);
    if (!ids.has(result.id)) throw new Error(`REPORT_RESULT_ID_UNKNOWN:${suite}:${result.id}`);
    byId.set(result.id, result);
  }
  return [...cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((testCase) => {
      const result = byId.get(testCase.id);
      if (!result) throw new Error(`REPORT_RESULT_MISSING:${suite}:${testCase.id}`);
      return { case: testCase, result };
    });
}

function countStatuses(statuses: readonly EvalCaseStatus[]): StatusCounts {
  const counts: StatusCounts = { PASS: 0, FAIL: 0, BLOCKED_UNSUPPORTED: 0, BLOCKED_ENVIRONMENT: 0, NOT_RUN: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

function addCounts(left: StatusCounts, right: StatusCounts): StatusCounts {
  return Object.fromEntries(STATUSES.map((status) => [status, left[status] + right[status]])) as StatusCounts;
}

function renderCoverageMatrix(
  retrieval: Array<{ case: RetrievalEvalCaseV2; result: RetrievalEvalCaseResultV2 }>,
  product: Array<{ case: ProductEvalCaseV2; result: ProductEvalCaseResultV2 }>,
): string {
  const header = ['suite', 'source_id', 'domain', 'execution_kind', 'provider_mode', 'status', 'tasks', 'mode', 'evidence_scope', 'capabilities', 'failure_reason'];
  const rows = [
    ...retrieval.map(({ case: testCase, result }) => [
      'retrieval', testCase.id, testCase.concept, 'KNOWLEDGE_SEARCH', result.providerMode, result.status,
      '', '', testCase.expectation.kind === 'POSITIVE' ? testCase.expectation.expectedScope : '', '', result.failureReasons.join(' | '),
    ]),
    ...product.map(({ case: testCase, result }) => [
      'product', testCase.id, testCase.domain, testCase.execution.kind, result.providerMode, result.status,
      testCase.expected.tasks.join('|'), testCase.expected.mode, testCase.expected.evidence.scopes.join('|'),
      testCase.execution.requiredCapabilities.join('|'), result.failureReasons.join(' | '),
    ]),
  ];
  return [header, ...rows].map((row) => row.map(escapeEvalV2Csv).join(',')).join('\n').concat('\n');
}

function renderMarkdown(title: string, counts: StatusCounts, cases: unknown[], safetyBlockerFailures: string[]): string {
  const lines = [`# ${title}`, '', '## Summary', ''];
  for (const status of STATUSES) lines.push(`- ${status}: ${counts[status]}`);
  lines.push('', `- Total: ${cases.length}`);
  if (safetyBlockerFailures.length) lines.push(`- Safety blocker failures: ${safetyBlockerFailures.join(', ')}`);
  lines.push(
    '',
    '## Cases',
    '',
    '| Source ID | Status | Severity | Duration (ms) | Tasks | Mode | Context | Evidence | Tools | Output | Failure reasons |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const entry of cases) {
    const caseResult = asRecord(entry);
    const actual = asRecord(caseResult.actual);
    const assertions = Array.isArray(caseResult.assertions) ? caseResult.assertions.map(String).join('; ') : '';
    const taskDetails = Array.isArray(actual.taskDetails) ? actual.taskDetails.map(asRecord) : [];
    const contexts = taskDetails.flatMap((detail) => {
      const context = asRecord(detail.result).context;
      return context === undefined ? [] : [context];
    });
    const evidence = Array.isArray(actual.evidence) ? actual.evidence : [];
    lines.push([
      stringValue(caseResult.sourceId),
      stringValue(caseResult.status),
      stringValue(caseResult.gateSeverity),
      String(numberValue(caseResult.durationMs)),
      stringArray(actual.tasks).join(', '),
      stringValue(actual.mode) || stringValue(actual.retrievalStatus),
      contexts.length ? compactJson(contexts) : '',
      evidence.length ? compactJson(evidence) : '',
      stringArray(actual.tools).join(', '),
      stringValue(actual.text) || stringValue(actual.retrievalStatus),
      assertions,
    ].map(escapeMarkdownCell).join(' | ').replace(/^/u, '| ').concat(' |'));
  }
  return `${lines.join('\n')}\n`;
}

function runIdFor(startedAt: string, commit: string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.valueOf())) throw new Error(`REPORT_STARTED_AT_INVALID:${startedAt}`);
  const utc = date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
  const shortCommit = commit.slice(0, 7).replace(/[^a-zA-Z0-9]/gu, '');
  if (!shortCommit) throw new Error('REPORT_COMMIT_INVALID');
  return `${utc}-${shortCommit}`;
}

function rejectSecretFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectSecretFields);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new Error(`MANIFEST_SECRET_FIELD:${key}`);
    rejectSecretFields(child);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/[|\r\n]/gu, ' ');
}
