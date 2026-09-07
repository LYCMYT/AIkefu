import { runEvalV2Cli, runEvalV2Command, type EvalV2CliRuntime } from '../src/eval-v2/eval-v2.cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createFileOnlyRuntime } from '../src/eval-v2/eval-v2.cli';
import type { EvalCaseStatus, ProductEvalCaseV2, RetrievalEvalCaseV2 } from '../src/eval-v2/eval-v2.types';
import type { ProductEvalCaseResultV2 } from '../src/eval-v2/product-eval.executor';
import type { RetrievalEvalCaseResultV2 } from '../src/eval-v2/retrieval-eval.executor';

const retrievalCase = { id: 'Q01', sourceRow: 2, shopKey: 'shop_mia_fashion', productKey: null, query: 'q', concept: 'c', expectation: { kind: 'NO_EVIDENCE', allowedStatuses: ['NO_EVIDENCE'], forbiddenKnowledgeKeys: [], forbiddenShopKeys: [], forbiddenProductKeys: [] }, notes: [] } as RetrievalEvalCaseV2;
const productCase = { id: 'K01', sourceRow: 2, domain: 'knowledge', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: [], setup: [], expected: { tasks: [], mode: 'ASSIST', terminalStatuses: [], outputSources: ['NONE'], evidence: { required: false, scopes: [], knowledgeKeys: [], productKeys: [] }, tools: [], requiredFacts: [], forbiddenClaims: [], maxClarificationQuestions: null, autoSend: null, oldReplyMustNotBeSent: false }, gateSeverity: 'STANDARD', execution: { kind: 'REPLY_RUNTIME', requiredCapabilities: [] }, metricTags: [], notes: [] } as ProductEvalCaseV2;

function runtime(status: EvalCaseStatus = 'PASS'): EvalV2CliRuntime & { writeReport: jest.Mock; executeRetrieval: jest.Mock; executeProduct: jest.Mock } {
  const retrievalResult = { id: 'Q01', status, passed: status === 'PASS', providerMode: 'OFFLINE_FIXTURE', durationMs: 1, failureReasons: [], actual: { retrievalStatus: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] } } as RetrievalEvalCaseResultV2;
  const productResult = { id: 'K01', status, passed: status === 'PASS', providerMode: 'OFFLINE_FIXTURE', durationMs: 1, gateSeverity: 'STANDARD', failureReasons: [] } as ProductEvalCaseResultV2;
  return {
    canonical: () => ({ retrieval: { source: { sha256: 'r' }, cases: [retrievalCase] }, product: { source: { sha256: 'p' }, cases: [productCase] } }),
    canonicalHashes: () => ({ retrieval: 'canonical-r', product: 'canonical-p' }),
    currentSourceHashes: () => ({ retrieval: 'r', product: 'p' }),
    executeRetrieval: jest.fn(async () => [retrievalResult]),
    executeProduct: jest.fn(async () => [productResult]),
    writeReport: jest.fn(() => ({ directory: 'artifacts/eval-v2/test', runId: 'test' })),
    metadata: (input) => ({ startedAt: input.startedAt, finishedAt: input.finishedAt, providerMode: input.mode, model: 'offline', git: { commit: 'abcdef0', dirty: true }, environment: { node: '22', pnpm: '9', os: 'test' }, sourceHashes: input.sourceHashes, canonicalHashes: input.canonicalHashes, commands: [{ command: 'eval:v2:test', exitCode: input.exitCode, durationMs: 1 }] }),
    realEnvironmentAvailable: () => true,
  };
}

describe('Eval V2 CLI', () => {
  it('runs conversion before offline and real suites in the root all command', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(__dirname, '../../..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(rootPackage.scripts['eval:v2:all']).toBe('pnpm eval:v2:convert && pnpm eval:v2:offline && pnpm eval:v2:real');
  });

  it('passes separately measured canonical hashes and execution timing to the manifest runtime', async () => {
    const fixture = runtime();
    await runEvalV2Cli(['--offline-fixture'], fixture);
    const input = fixture.writeReport.mock.calls[0][0] as { run: { canonicalHashes: unknown; sourceHashes: unknown; commands: Array<{ exitCode: number }> } };
    expect(input.run.canonicalHashes).toEqual({ retrieval: 'canonical-r', product: 'canonical-p' });
    expect(input.run.sourceHashes).toEqual({ retrieval: 'r', product: 'p' });
    expect(input.run.commands).toEqual([{ command: 'eval:v2:test', exitCode: 0, durationMs: 1 }]);
  });

  it('measures canonical file digests independently from source digests', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const fileRuntime = createFileOnlyRuntime(repoRoot);
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(fileRuntime.canonicalHashes()).toEqual({
      retrieval: hash(resolve(repoRoot, 'evals/canonical/retrieval-40.v2.json')),
      product: hash(resolve(repoRoot, 'evals/canonical/product-testset-72.v2.json')),
    });
    expect(fileRuntime.currentSourceHashes()).not.toEqual(fileRuntime.canonicalHashes());
  });

  it('does not label the deterministic provider as REAL_PROVIDER merely because a key is present', () => {
    const keys = ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT', 'AI_PROVIDER', 'AI_API_KEY', 'AI_OFFLINE_MODE'] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.DATABASE_URL = 'postgresql://local/example';
      process.env.REDIS_URL = 'redis://local';
      process.env.S3_ENDPOINT = 'http://local';
      process.env.AI_PROVIDER = 'deterministic';
      process.env.AI_API_KEY = 'test-only-placeholder';
      process.env.AI_OFFLINE_MODE = '0';

      expect(createFileOnlyRuntime(resolve(__dirname, '../../..')).environmentAvailable?.('REAL_PROVIDER')).toBe(false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(['FAIL', 'BLOCKED_UNSUPPORTED', 'NOT_RUN'] as const)('returns nonzero when a case is %s and still writes a report', async (status) => {
    const fixture = runtime(status);
    const result = await runEvalV2Cli(['--offline-fixture'], fixture);
    expect(result.exitCode).toBe(1);
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
  });

  it('rejects mutually exclusive provider flags', async () => {
    const result = await runEvalV2Cli(['--offline-fixture', '--real-provider'], runtime());
    expect(result.exitCode).toBe(2);
    expect(result.error).toBe('CLI_PROVIDER_MODE_EXACTLY_ONE');
  });

  it('rejects stray positional values even when they resemble a suite name', async () => {
    const result = await runEvalV2Cli(['--offline-fixture', 'product'], runtime());
    expect(result).toMatchObject({ exitCode: 2, error: 'CLI_ARGUMENT_UNKNOWN:product' });
  });

  it('rejects duplicate suite flags instead of silently taking the first one', async () => {
    const result = await runEvalV2Cli(
      ['--offline-fixture', '--suite', 'retrieval', '--suite', 'product'],
      runtime(),
    );
    expect(result).toMatchObject({ exitCode: 2, error: 'CLI_SUITE_DUPLICATE' });
  });

  it('returns blocked-environment rather than pass when real infrastructure is absent', async () => {
    const fixture = runtime();
    fixture.realEnvironmentAvailable = () => false;
    const result = await runEvalV2Cli(['--real-provider'], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({ blockedEnvironment: 2, total: 2 });
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
  });

  it('refuses to evaluate against a database currently claimed by a live API process', async () => {
    const fixture = runtime();
    fixture.liveApiUsingSameDatabase = () => true;
    const result = await runEvalV2Cli(['--offline-fixture'], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('EVAL_LIVE_API_SAME_DATABASE');
    expect(result.summary.blockedEnvironment).toBe(2);
    expect(fixture.executeRetrieval).not.toHaveBeenCalled();
  });

  it('classifies an executor environment failure as blocked instead of a test failure', async () => {
    const fixture = runtime();
    fixture.executeRetrieval.mockRejectedValue(new Error('EVAL_ENVIRONMENT_UNAVAILABLE:DATABASE_URL'));
    const result = await runEvalV2Cli(['--offline-fixture'], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({ passed: 1, blockedEnvironment: 1, failed: 0 });
    const report = fixture.writeReport.mock.calls[0][0] as {
      retrieval: { results: Array<{ status: string }> };
      product: { results: Array<{ status: string }> };
    };
    expect(report.retrieval.results).toEqual([expect.objectContaining({ status: 'BLOCKED_ENVIRONMENT' })]);
    expect(report.product.results).toEqual([expect.objectContaining({ status: 'PASS' })]);
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
  });

  it('runs the two real-infrastructure suites sequentially so they cannot exhaust one database pool', async () => {
    const fixture = runtime();
    const calls: string[] = [];
    fixture.executeRetrieval.mockImplementation(async () => {
      calls.push('retrieval:start');
      await Promise.resolve();
      calls.push('retrieval:end');
      return [
        { id: 'Q01', status: 'PASS', passed: true, providerMode: 'OFFLINE_FIXTURE', durationMs: 1, failureReasons: [], actual: { retrievalStatus: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] } },
      ];
    });
    fixture.executeProduct.mockImplementation(async () => {
      calls.push('product:start');
      return [
        { id: 'K01', status: 'PASS', passed: true, providerMode: 'OFFLINE_FIXTURE', durationMs: 1, gateSeverity: 'STANDARD', failureReasons: [] },
      ];
    });

    await runEvalV2Cli(['--offline-fixture'], fixture);

    expect(calls).toEqual(['retrieval:start', 'retrieval:end', 'product:start']);
  });

  it('holds one atomic database lease across AppModule creation, execution, and close', async () => {
    const fixture = runtime();
    fixture.liveApiUsingSameDatabase = () => false;
    fixture.environmentAvailable = () => true;
    const calls: string[] = [];
    const leasedRuntime = fixture as EvalV2CliRuntime & { acquireDatabaseLease?: () => { release(): void } };
    leasedRuntime.acquireDatabaseLease = () => {
      calls.push('lease:acquire');
      return { release: () => { calls.push('lease:release'); } };
    };

    const result = await runEvalV2Command(
      ['--offline-fixture'],
      leasedRuntime,
      async () => ({
        ...fixture,
        executeRetrieval: jest.fn(async () => { calls.push('execute'); return fixture.executeRetrieval(); }),
        close: async () => { calls.push('runtime:close'); },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['lease:acquire', 'execute', 'runtime:close', 'lease:release']);
  });

  it('still writes a blocked report when the live AppModule cannot start', async () => {
    const fixture = runtime();
    fixture.liveApiUsingSameDatabase = () => false;
    fixture.environmentAvailable = () => true;
    const result = await runEvalV2Command(
      ['--offline-fixture'],
      fixture,
      async () => { throw new Error('database refused connection'); },
    );

    expect(result).toMatchObject({ exitCode: 1, summary: { blockedEnvironment: 2, failed: 0 } });
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
  });

  it('rejects canonical source SHA drift and records every selected case as not run', async () => {
    const fixture = runtime();
    fixture.currentSourceHashes = () => ({ retrieval: 'changed', product: 'p' });
    const result = await runEvalV2Cli(['--offline-fixture'], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('CANONICAL_SOURCE_SHA_DRIFT:retrieval');
    expect(result.summary).toMatchObject({ notRun: 2, total: 2 });
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
  });
});
