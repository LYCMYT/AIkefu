import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  acquireDatabaseLease as acquireLocalDatabaseLease,
  hasActiveDatabaseLease,
  type DatabaseLease,
  type DatabaseLeaseOptions,
} from './database-lease';
import { loadEvalV2Sources } from './eval-v2.loader';
import { writeEvalV2ReportAtomically, type EvalV2ReportInput } from './eval-v2.reporter';
import type { ProductEvalCaseResultV2 } from './product-eval.executor';
import type { RetrievalEvalCaseResultV2 } from './retrieval-eval.executor';
import type { EvalCaseStatus, EvalProviderMode, ProductEvalCaseV2, RetrievalEvalCaseV2 } from './eval-v2.types';

type CanonicalBundle = {
  retrieval: { source: { sha256: string }; cases: RetrievalEvalCaseV2[] };
  product: { source: { sha256: string }; cases: ProductEvalCaseV2[] };
};

export type EvalV2CliMetadata = EvalV2ReportInput['run'];

/** The CLI owns orchestration; execution remains behind the existing V2 ports. */
export type EvalV2CliRuntime = {
  canonical(): CanonicalBundle;
  canonicalHashes(): { retrieval: string; product: string };
  currentSourceHashes(): { retrieval: string; product: string };
  executeRetrieval(cases: readonly RetrievalEvalCaseV2[], mode: EvalProviderMode): Promise<RetrievalEvalCaseResultV2[]>;
  executeProduct(cases: readonly ProductEvalCaseV2[], mode: EvalProviderMode): Promise<ProductEvalCaseResultV2[]>;
  writeReport(input: EvalV2ReportInput): { directory: string; runId: string };
  metadata(input: { mode: EvalProviderMode; sourceHashes: { retrieval: string; product: string }; canonicalHashes: { retrieval: string; product: string }; startedAt: string; finishedAt: string; exitCode: number }): EvalV2CliMetadata;
  realEnvironmentAvailable(): boolean;
  environmentAvailable?(mode: EvalProviderMode): boolean;
  liveApiUsingSameDatabase?(): boolean | Promise<boolean>;
  acquireDatabaseLease?(): DatabaseLease;
  close?(): Promise<void>;
};

export type EvalV2CliResult = {
  exitCode: 0 | 1 | 2;
  error?: string;
  reportDirectory?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    blockedUnsupported: number;
    blockedEnvironment: number;
    notRun: number;
  };
};

type ParsedArguments = { mode: EvalProviderMode; suite: 'retrieval' | 'product' | 'all' } | { error: string };

export async function runEvalV2Cli(argv: readonly string[], runtime: EvalV2CliRuntime = createFileOnlyRuntime()): Promise<EvalV2CliResult> {
  const startedAt = new Date().toISOString();
  const parsed = parseArguments(argv);
  if ('error' in parsed) return { exitCode: 2, error: parsed.error, summary: emptySummary() };

  const canonical = runtime.canonical();
  const selected = selectSuites(canonical, parsed.suite);
  const sourceHashes = runtime.currentSourceHashes();
  const canonicalHashes = runtime.canonicalHashes();
  let error: string | undefined;
  let retrievalResults: RetrievalEvalCaseResultV2[];
  let productResults: ProductEvalCaseResultV2[];

  const drift = canonicalDrift(canonical, sourceHashes);
  if (await runtime.liveApiUsingSameDatabase?.()) {
    error = 'EVAL_LIVE_API_SAME_DATABASE';
    retrievalResults = selected.retrieval.map((testCase) => blockedRetrieval(testCase, parsed.mode, error!));
    productResults = selected.product.map((testCase) => blockedProduct(testCase, parsed.mode, error!));
  } else if (drift) {
    error = drift;
    retrievalResults = selected.retrieval.map((testCase) => notRunRetrieval(testCase, parsed.mode, drift));
    productResults = selected.product.map((testCase) => notRunProduct(testCase, parsed.mode, drift));
  } else if (!(runtime.environmentAvailable?.(parsed.mode) ?? (parsed.mode !== 'REAL_PROVIDER' || runtime.realEnvironmentAvailable()))) {
    error = 'EVAL_ENVIRONMENT_UNAVAILABLE:REAL_INFRA_REQUIRED';
    retrievalResults = selected.retrieval.map((testCase) => blockedRetrieval(testCase, parsed.mode, error!));
    productResults = selected.product.map((testCase) => blockedProduct(testCase, parsed.mode, error!));
  } else {
    // Both suites must always run and be reported, but they share the same
    // bounded Prisma pool in one AppModule. Run them sequentially so a large
    // product suite cannot starve the final retrieval transactions.
    const retrievalOutcome = await settle(() => (
      selected.retrieval.length ? runtime.executeRetrieval(selected.retrieval, parsed.mode) : Promise.resolve([])
    ));
    const productOutcome = await settle(() => (
      selected.product.length ? runtime.executeProduct(selected.product, parsed.mode) : Promise.resolve([])
    ));
    const errors: string[] = [];
    if (retrievalOutcome.status === 'fulfilled') {
      retrievalResults = retrievalOutcome.value;
    } else {
      const detail = message(retrievalOutcome.reason);
      const reason = detail.startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:') ? detail : `EVAL_EXECUTION_FAILED:${detail}`;
      errors.push(`retrieval:${reason}`);
      retrievalResults = selected.retrieval.map((testCase) => detail.startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:')
        ? blockedRetrieval(testCase, parsed.mode, reason)
        : failedRetrieval(testCase, parsed.mode, reason));
    }
    if (productOutcome.status === 'fulfilled') {
      productResults = productOutcome.value;
    } else {
      const detail = message(productOutcome.reason);
      const reason = detail.startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:') ? detail : `EVAL_EXECUTION_FAILED:${detail}`;
      errors.push(`product:${reason}`);
      productResults = selected.product.map((testCase) => detail.startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:')
        ? blockedProduct(testCase, parsed.mode, reason)
        : failedProduct(testCase, parsed.mode, reason));
    }
    if (errors.length) error = errors.join('|');
  }

  const summary = summarize([...retrievalResults, ...productResults]);
  const exitCode = summary.passed === summary.total && !error ? 0 : 1;
  const report = runtime.writeReport({
    run: runtime.metadata({ mode: parsed.mode, sourceHashes, canonicalHashes, startedAt, finishedAt: new Date().toISOString(), exitCode }),
    retrieval: { cases: selected.retrieval, results: retrievalResults },
    product: { cases: selected.product, results: productResults },
  });
  return {
    exitCode,
    ...(error ? { error } : {}),
    reportDirectory: report.directory,
    summary,
  };
}

async function settle<T>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await work() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let mode: EvalProviderMode | undefined;
  let suite: 'retrieval' | 'product' | 'all' = 'all';
  let suiteSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--offline-fixture' || argument === '--real-provider') {
      if (mode) return { error: 'CLI_PROVIDER_MODE_EXACTLY_ONE' };
      mode = argument === '--offline-fixture' ? 'OFFLINE_FIXTURE' : 'REAL_PROVIDER';
      continue;
    }
    if (argument === '--suite') {
      if (suiteSeen) return { error: 'CLI_SUITE_DUPLICATE' };
      suiteSeen = true;
      const value = argv[index + 1];
      if (!['retrieval', 'product', 'all'].includes(value ?? '')) return { error: 'CLI_SUITE_INVALID' };
      suite = value as 'retrieval' | 'product' | 'all';
      index += 1;
      continue;
    }
    return { error: `CLI_ARGUMENT_UNKNOWN:${argument}` };
  }
  if (!mode) return { error: 'CLI_PROVIDER_MODE_EXACTLY_ONE' };
  return { mode, suite };
}

function selectSuites(canonical: CanonicalBundle, suite: 'retrieval' | 'product' | 'all') {
  return {
    retrieval: suite === 'product' ? [] : canonical.retrieval.cases,
    product: suite === 'retrieval' ? [] : canonical.product.cases,
  };
}

function canonicalDrift(canonical: CanonicalBundle, hashes: { retrieval: string; product: string }): string | undefined {
  if (canonical.retrieval.source.sha256 !== hashes.retrieval) return 'CANONICAL_SOURCE_SHA_DRIFT:retrieval';
  if (canonical.product.source.sha256 !== hashes.product) return 'CANONICAL_SOURCE_SHA_DRIFT:product';
  return undefined;
}

function summarize(results: Array<{ status: EvalCaseStatus }>): EvalV2CliResult['summary'] {
  const count = (status: EvalCaseStatus) => results.filter((entry) => entry.status === status).length;
  return { total: results.length, passed: count('PASS'), failed: count('FAIL'), blockedUnsupported: count('BLOCKED_UNSUPPORTED'), blockedEnvironment: count('BLOCKED_ENVIRONMENT'), notRun: count('NOT_RUN') };
}

function emptySummary(): EvalV2CliResult['summary'] { return { total: 0, passed: 0, failed: 0, blockedUnsupported: 0, blockedEnvironment: 0, notRun: 0 }; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

function retrievalResult(testCase: RetrievalEvalCaseV2, mode: EvalProviderMode, status: EvalCaseStatus, reason: string): RetrievalEvalCaseResultV2 {
  return { id: testCase.id, status, passed: false, providerMode: mode, durationMs: 0, failureReasons: [reason], actual: { retrievalStatus: 'EXECUTION_ERROR', evidence: [], conflictItemIds: [] } };
}
function productResult(testCase: ProductEvalCaseV2, mode: EvalProviderMode, status: EvalCaseStatus, reason: string): ProductEvalCaseResultV2 {
  return { id: testCase.id, status, passed: false, providerMode: mode, durationMs: 0, gateSeverity: testCase.gateSeverity, failureReasons: [reason] };
}
const notRunRetrieval = (testCase: RetrievalEvalCaseV2, mode: EvalProviderMode, reason: string) => retrievalResult(testCase, mode, 'NOT_RUN', reason);
const notRunProduct = (testCase: ProductEvalCaseV2, mode: EvalProviderMode, reason: string) => productResult(testCase, mode, 'NOT_RUN', reason);
const blockedRetrieval = (testCase: RetrievalEvalCaseV2, mode: EvalProviderMode, reason: string) => retrievalResult(testCase, mode, 'BLOCKED_ENVIRONMENT', reason);
const blockedProduct = (testCase: ProductEvalCaseV2, mode: EvalProviderMode, reason: string) => productResult(testCase, mode, 'BLOCKED_ENVIRONMENT', reason);
const failedRetrieval = (testCase: RetrievalEvalCaseV2, mode: EvalProviderMode, reason: string) => retrievalResult(testCase, mode, 'FAIL', reason);
const failedProduct = (testCase: ProductEvalCaseV2, mode: EvalProviderMode, reason: string) => productResult(testCase, mode, 'FAIL', reason);

/**
 * This deliberately does not manufacture fixture answers. Production command
 * wiring must provide the live ports; when no infrastructure is configured the
 * report honestly records a blocked run rather than a synthetic PASS.
 */
export function createFileOnlyRuntime(repoRoot = resolve(__dirname, '../../../..'), leaseOptions: DatabaseLeaseOptions = {}): EvalV2CliRuntime {
  const canonicalPath = (file: string) => resolve(repoRoot, 'evals/canonical', file);
  const canonical = (): CanonicalBundle => ({
    retrieval: readJson(canonicalPath('retrieval-40.v2.json')),
    product: readJson(canonicalPath('product-testset-72.v2.json')),
  });
  const currentSourceHashes = () => {
    const source = loadEvalV2Sources(repoRoot);
    return { retrieval: sha256File(source.paths.retrieval), product: sha256File(source.paths.product) };
  };
  const canonicalHashes = () => ({
    retrieval: sha256File(canonicalPath('retrieval-40.v2.json')),
    product: sha256File(canonicalPath('product-testset-72.v2.json')),
  });
  return {
    canonical,
    canonicalHashes,
    currentSourceHashes,
    async executeRetrieval() { throw new Error('EVAL_ENVIRONMENT_UNAVAILABLE:LIVE_EXECUTOR_NOT_CONFIGURED'); },
    async executeProduct() { throw new Error('EVAL_ENVIRONMENT_UNAVAILABLE:LIVE_EXECUTOR_NOT_CONFIGURED'); },
    writeReport: (input) => writeEvalV2ReportAtomically(input, resolve(repoRoot, 'artifacts/eval-v2')),
    metadata: (input) => metadataFor(input),
    realEnvironmentAvailable: () => configuredRealProviderEnvironment(),
    environmentAvailable: (mode) => mode === 'OFFLINE_FIXTURE'
      ? Boolean(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT)
      : configuredRealProviderEnvironment(),
    liveApiUsingSameDatabase: () => Boolean(process.env.DATABASE_URL)
      && hasActiveDatabaseLease(process.env.DATABASE_URL!, leaseOptions),
    acquireDatabaseLease: () => {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (!databaseUrl) throw new Error('EVAL_ENVIRONMENT_UNAVAILABLE:DATABASE_URL');
      return acquireLocalDatabaseLease(databaseUrl, leaseOptions);
    },
  };
}

/** Checks disk inputs and environment before the process constructs AppModule. */
export async function evalV2CliPreflightPasses(argv: readonly string[], runtime: EvalV2CliRuntime): Promise<boolean> {
  const parsed = parseArguments(argv);
  if ('error' in parsed) return false;
  const canonical = runtime.canonical();
  if (await runtime.liveApiUsingSameDatabase?.()) return false;
  if (canonicalDrift(canonical, runtime.currentSourceHashes())) return false;
  return runtime.environmentAvailable?.(parsed.mode) ?? (parsed.mode !== 'REAL_PROVIDER' || runtime.realEnvironmentAvailable());
}

type EvalV2LiveRuntimeFactory = (mode: EvalProviderMode) => Promise<EvalV2CliRuntime>;

/**
 * Keeps AppModule behind file-only preflight and turns startup failures into a
 * complete BLOCKED_ENVIRONMENT report instead of losing the run evidence.
 */
export async function runEvalV2Command(
  argv: readonly string[],
  fileRuntime: EvalV2CliRuntime = createFileOnlyRuntime(),
  createLiveRuntime: EvalV2LiveRuntimeFactory = async (mode) => {
    const { createLiveEvalV2CliRuntime } = await import('./eval-v2.live-runtime');
    return createLiveEvalV2CliRuntime(undefined, mode);
  },
): Promise<EvalV2CliResult> {
  if (!(await evalV2CliPreflightPasses(argv, fileRuntime))) {
    return runEvalV2Cli(argv, fileRuntime);
  }
  const parsed = parseArguments(argv);
  if ('error' in parsed) return runEvalV2Cli(argv, fileRuntime);
  let lease: DatabaseLease | undefined;
  try {
    lease = fileRuntime.acquireDatabaseLease?.();
  } catch (cause) {
    if (message(cause) === 'DATABASE_LEASE_ALREADY_ACTIVE') {
      return runEvalV2Cli(argv, { ...fileRuntime, liveApiUsingSameDatabase: () => true });
    }
    const reason = message(cause).startsWith('EVAL_ENVIRONMENT_UNAVAILABLE:')
      ? message(cause)
      : `EVAL_ENVIRONMENT_UNAVAILABLE:DATABASE_LEASE:${message(cause)}`;
    return runEvalV2Cli(argv, environmentFailureRuntime(fileRuntime, reason));
  }
  let liveRuntime: EvalV2CliRuntime | undefined;
  try {
    try {
      liveRuntime = await createLiveRuntime(parsed.mode);
    } catch {
      return await runEvalV2Cli(argv, environmentFailureRuntime(fileRuntime, 'EVAL_ENVIRONMENT_UNAVAILABLE:APP_MODULE_START_FAILED'));
    }
    return await runEvalV2Cli(argv, liveRuntime);
  } finally {
    await liveRuntime?.close?.();
    lease?.release();
  }
}

function environmentFailureRuntime(runtime: EvalV2CliRuntime, reason: string): EvalV2CliRuntime {
  return {
    ...runtime,
    liveApiUsingSameDatabase: () => false,
    executeRetrieval: async () => { throw new Error(reason); },
    executeProduct: async () => { throw new Error(reason); },
  };
}

function readJson(path: string): { source: { sha256: string }; cases: never[] } {
  if (!existsSync(path)) throw new Error(`CANONICAL_FILE_MISSING:${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as { source: { sha256: string }; cases: never[] };
}
function sha256File(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function metadataFor(input: { mode: EvalProviderMode; sourceHashes: { retrieval: string; product: string }; canonicalHashes: { retrieval: string; product: string }; startedAt: string; finishedAt: string; exitCode: number }): EvalV2CliMetadata {
  const git = gitMetadata();
  return { startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)), providerMode: input.mode, providerName: input.mode === 'OFFLINE_FIXTURE' ? 'offline-structured-demo' : (process.env.AI_PROVIDER ?? 'unconfigured'), model: process.env.AI_MODEL_NAME ?? (input.mode === 'OFFLINE_FIXTURE' ? 'offline-structured-v1' : 'configured-model'), git, environment: { node: process.version, pnpm: process.env.npm_package_manager ?? 'unknown', os: process.platform }, sourceHashes: input.sourceHashes, canonicalHashes: input.canonicalHashes, commands: [{ command: `eval:v2:${input.mode === 'OFFLINE_FIXTURE' ? 'offline' : 'real'}`, exitCode: input.exitCode, durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)) }] };
}

function gitMetadata(): { commit: string; dirty: boolean } {
  try {
    const cwd = resolve(__dirname, '../../../..');
    return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim().length > 0 };
  } catch { return { commit: process.env.GITHUB_SHA ?? 'unknown', dirty: true }; }
}

function configuredRealProviderEnvironment(): boolean {
  const provider = process.env.AI_PROVIDER?.trim() ?? '';
  const hasProvider = Boolean(provider)
    && !/^(?:deterministic|offline|fixture)$/iu.test(provider)
    && process.env.AI_OFFLINE_MODE !== '1';
  const hasCredential = Boolean(process.env.AI_API_KEY?.trim() || process.env.AI_API_KEY_FILE?.trim() || process.env.AI_MODEL_GATEWAY_SECRET?.trim());
  return Boolean(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT && hasProvider && hasCredential);
}

if (require.main === module) {
  const fileRuntime = createFileOnlyRuntime();
  void runEvalV2Command(process.argv.slice(2), fileRuntime).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(`Eval V2 CLI failed before report: ${message(error)}\n`);
    process.exitCode = 1;
  });
}
