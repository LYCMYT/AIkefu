import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEvalV2Report,
  escapeEvalV2Csv,
  sanitizeEvalV2Manifest,
  writeEvalV2ReportAtomically,
  type EvalV2ReportInput,
} from '../src/eval-v2/eval-v2.reporter';

const statuses = ['PASS', 'FAIL', 'BLOCKED_UNSUPPORTED', 'BLOCKED_ENVIRONMENT', 'NOT_RUN'] as const;

function reportInput(overrides: Partial<EvalV2ReportInput> = {}): EvalV2ReportInput {
  const retrieval = Array.from({ length: 40 }, (_, index) => ({
    id: `Q${String(index + 1).padStart(2, '0')}`,
    sourceRow: index + 2,
    shopKey: 'shop_mia_fashion',
    productKey: null,
    query: `query-${index + 1}`,
    concept: 'synthetic',
    expectation: { kind: 'NO_EVIDENCE' as const, allowedStatuses: ['NO_EVIDENCE' as const], forbiddenKnowledgeKeys: [], forbiddenShopKeys: [], forbiddenProductKeys: [] },
    notes: [],
  }));
  const product = Array.from({ length: 72 }, (_, index) => ({
    id: `${index < 10 ? 'K' : 'P'}${String(index + 1).padStart(2, '0')}`,
    sourceRow: index + 2,
    domain: 'Synthetic',
    shopKey: 'shop_mia_fashion',
    buyerKey: 'buyer_001',
    messages: [{ type: 'TEXT' as const, text: `message-${index + 1}`, turn: 1 }],
    setup: [],
    expected: { tasks: [], mode: 'ASSIST' as const, terminalStatuses: ['WAITING_HUMAN'], outputSources: ['DRAFT' as const], evidence: { required: false, scopes: [], knowledgeKeys: [], productKeys: [] }, tools: [], requiredFacts: [], forbiddenClaims: [], maxClarificationQuestions: null, autoSend: null, oldReplyMustNotBeSent: false },
    gateSeverity: index === 1 ? 'SAFETY_BLOCKER' as const : 'STANDARD' as const,
    execution: { kind: 'REPLY_RUNTIME' as const, requiredCapabilities: ['TEXT_TURN'] },
    metricTags: [],
    notes: [],
  }));
  const all = [...retrieval, ...product];
  return {
    run: {
      startedAt: '2026-09-07T10:11:12.000Z',
      finishedAt: '2026-09-07T10:12:12.000Z',
      providerMode: 'OFFLINE_FIXTURE',
      model: 'deterministic-fixture',
      git: { commit: 'abcdef123456', dirty: true },
      environment: { node: 'v22.0.0', pnpm: '9.15.9', os: 'win32' },
      sourceHashes: { retrieval: 'source-retrieval', product: 'source-product' },
      canonicalHashes: { retrieval: 'canonical-retrieval', product: 'canonical-product' },
      commands: [{ command: 'eval:v2:offline', exitCode: 0, durationMs: 60_000 }],
    },
    retrieval: { cases: retrieval, results: retrieval.map((entry) => ({ id: entry.id, status: 'PASS' as const, passed: true, providerMode: 'OFFLINE_FIXTURE' as const, durationMs: 1, failureReasons: [], actual: { retrievalStatus: 'NO_EVIDENCE' as const, evidence: [], conflictItemIds: [] } })) },
    product: { cases: product, results: product.map((entry) => ({ id: entry.id, status: 'PASS' as const, passed: true, providerMode: 'OFFLINE_FIXTURE' as const, durationMs: 2, gateSeverity: entry.gateSeverity, failureReasons: [] })) },
    ...overrides,
  };
}

describe('Eval V2 reporter', () => {
  it('counts all five mutually exclusive statuses and never treats blocked or not-run as passed', () => {
    const base = reportInput();
    const input: EvalV2ReportInput = {
      ...base,
      retrieval: {
        ...base.retrieval,
        results: base.retrieval.results.map((result, index) => index === 0
          ? { ...result, status: 'FAIL', passed: false, failureReasons: ['wrong'] }
          : index === 1
            ? { ...result, status: 'BLOCKED_UNSUPPORTED', passed: false, failureReasons: ['missing'] }
            : result),
      },
      product: {
        ...base.product,
        results: base.product.results.map((result, index) => index === 0
          ? { ...result, status: 'BLOCKED_ENVIRONMENT', passed: false, failureReasons: ['postgres'] }
          : index === 1
            ? { ...result, status: 'NOT_RUN', passed: false, failureReasons: ['cancelled'] }
            : result),
      },
    };

    const report = buildEvalV2Report(input);

    expect(report.summary.statusCounts).toEqual({ PASS: 108, FAIL: 1, BLOCKED_UNSUPPORTED: 1, BLOCKED_ENVIRONMENT: 1, NOT_RUN: 1 });
    expect(report.summary.passed).toBe(108);
    expect(report.summary.safetyBlockerFailures).toEqual(['K02']);
    expect(report.markdown.retrieval).toContain('BLOCKED_UNSUPPORTED: 1');
  });

  it('creates exactly one coverage row for each of the 112 source IDs', () => {
    const report = buildEvalV2Report(reportInput());
    const rows = report.coverageMatrix.trim().split('\n');

    expect(rows).toHaveLength(113);
    expect(new Set(rows.slice(1).map((row) => row.split(',')[1])).size).toBe(112);
  });

  it('keeps JSON summary and Markdown summary identical', () => {
    const report = buildEvalV2Report(reportInput());

    for (const status of statuses) expect(report.markdown.retrieval).toContain(`${status}: ${report.summary.retrievalStatusCounts[status]}`);
    for (const status of statuses) expect(report.markdown.product).toContain(`${status}: ${report.summary.productStatusCounts[status]}`);
  });

  it('renders the product audit trail fields in Markdown rather than only status labels', () => {
    const input = reportInput();
    input.product.results = input.product.results.map((result, index) => index === 0 ? {
      ...result,
      observation: {
        text: '白色目前有现货。', tasks: ['INVENTORY_QUERY'], mode: 'ASSIST', terminalStatus: 'WAITING_HUMAN',
        outputSource: 'DRAFT', evidence: [{ knowledgeKey: 'k032', scope: 'PRODUCT', productKey: 'fashion_hoodie' }],
        tools: ['GET_INVENTORY'], taskDetails: [{ intent: 'INVENTORY_QUERY', status: 'RESOLVED', result: { context: { kind: 'SKU' } } }],
        sentOutbox: false, projectedMessage: false, oldReplySent: false,
      },
    } : result);

    const markdown = buildEvalV2Report(input).markdown.product;

    expect(markdown).toContain('| Source ID | Status | Severity | Duration (ms) | Tasks | Mode | Context | Evidence | Tools | Output | Failure reasons |');
    expect(markdown).toContain('STANDARD');
    expect(markdown).toContain('INVENTORY_QUERY');
    expect(markdown).toContain('GET_INVENTORY');
    expect(markdown).toContain('白色目前有现货。');
    expect(markdown).toContain('k032');
  });

  it('retains provider mode and duration on every per-case JSON record', () => {
    const report = buildEvalV2Report(reportInput());
    const retrieval = report.retrievalResults[0] as Record<string, unknown>;
    const product = report.productResults[0] as Record<string, unknown>;

    expect(retrieval).toMatchObject({ providerMode: 'OFFLINE_FIXTURE', durationMs: 1 });
    expect(product).toMatchObject({ providerMode: 'OFFLINE_FIXTURE', durationMs: 2, gateSeverity: 'STANDARD' });
  });

  it('rejects secret-shaped manifest fields before anything can be written', () => {
    expect(() => sanitizeEvalV2Manifest({ commit: 'abcdef1', apiKey: 'do-not-write' })).toThrow('MANIFEST_SECRET_FIELD:apiKey');
    expect(() => sanitizeEvalV2Manifest({ authorization: 'do-not-write' })).toThrow('MANIFEST_SECRET_FIELD:authorization');
    expect(() => sanitizeEvalV2Manifest({ REDIS_URL: 'redis://do-not-write' })).toThrow('MANIFEST_SECRET_FIELD:REDIS_URL');
    expect(() => sanitizeEvalV2Manifest({ s3Endpoint: 'do-not-write' })).toThrow('MANIFEST_SECRET_FIELD:s3Endpoint');
    const directory = mkdtempSync(join(tmpdir(), 'aikefu-eval-v2-report-'));
    try {
      const input = reportInput();
      (input.run as unknown as { apiToken: string }).apiToken = 'do-not-write';
      expect(() => writeEvalV2ReportAtomically(input, directory)).toThrow('MANIFEST_SECRET_FIELD:apiToken');
      expect(existsSync(join(directory, '20260907T101112Z-abcdef1'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes stable JSON, Markdown and CSV using correct CSV escaping', () => {
    expect(escapeEvalV2Csv('a,"b"\nnext')).toBe('"a,""b""\nnext"');
    const directory = mkdtempSync(join(tmpdir(), 'aikefu-eval-v2-report-'));
    try {
      const written = writeEvalV2ReportAtomically(reportInput(), directory);
      expect(written.directory).toBe(join(directory, '20260907T101112Z-abcdef1'));
      expect(JSON.parse(readFileSync(join(written.directory, 'manifest.json'), 'utf8'))).toMatchObject({ git: { commit: 'abcdef123456' } });
      expect(readFileSync(join(written.directory, 'coverage-matrix.csv'), 'utf8')).toContain('suite,source_id');
      expect(readFileSync(join(written.directory, 'product-report.md'), 'utf8')).toContain('PASS: 72');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
