import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  compileEvalV2,
  compileEvalV2FromRepo,
  loadEvalV2RepositoryInput,
  writeEvalV2CanonicalAtomically,
} from '../src/eval-v2/eval-v2.converter';

const repoRoot = resolve(__dirname, '../../..');

describe('Eval V2 canonical compiler', () => {
  it('compiles every source ID exactly once with stable seed aliases', () => {
    const bundle = compileEvalV2FromRepo(repoRoot);
    const allIds = [...bundle.retrieval.cases, ...bundle.product.cases].map((entry) => entry.id);

    expect(bundle.schemaVersion).toBe('2.0');
    expect(bundle.retrieval.cases).toHaveLength(40);
    expect(bundle.product.cases).toHaveLength(72);
    expect(new Set(allIds).size).toBe(112);
    expect(bundle.retrieval.cases.find((entry) => entry.id === 'Q09')).toMatchObject({
      shopKey: 'shop_pixel_tech',
      productKey: 'tech_silent_keyboard',
    });
    expect(bundle.retrieval.cases.find((entry) => entry.id === 'Q37')?.expectation).toEqual({
      kind: 'CONFLICT',
      conflictFixtureKey: 'conflict_001',
      expectedStatus: 'CONFLICTED',
    });
    expect(bundle.product.cases.find((entry) => entry.id === 'P07')).toMatchObject({
      expected: {
        tasks: ['PRODUCT_RECOMMENDATION'],
        evidence: { required: false, scopes: [], knowledgeKeys: [], productKeys: [] },
      },
    });
    expect(bundle.product.cases.find((entry) => entry.id === 'S07')).toMatchObject({
      expected: { tasks: [], mode: 'MANUAL', autoSend: false },
    });
  });

  it('rejects an unmapped product alias instead of guessing', () => {
    const input = loadEvalV2RepositoryInput(repoRoot);
    input.source.retrieval[8] = { ...input.source.retrieval[8]!, Product_Context: 'unknown-product' };

    expect(() => compileEvalV2(input)).toThrow('PRODUCT_ALIAS_UNMAPPED:Q09:unknown-product');
  });

  it('rejects an override that references a source ID that does not exist', () => {
    const input = loadEvalV2RepositoryInput(repoRoot);
    input.overrides.retrieval.Q99 = { expectedKnowledgeKeys: ['k001'] };

    expect(() => compileEvalV2(input)).toThrow('OVERRIDE_SOURCE_ID_UNKNOWN:retrieval:Q99');
  });

  it('rejects a reliability setup that references a nonexistent SKU', () => {
    const input = loadEvalV2RepositoryInput(repoRoot);
    input.overrides.product.I05 = {
      ...input.overrides.product.I05,
      setup: [{
        type: 'CHANGE_INVENTORY_DURING_GENERATION',
        externalSkuId: 'missing-sku',
        from: 8,
        to: 0,
      }],
    };

    expect(() => compileEvalV2(input)).toThrow('SKU_KEY_INVALID:I05:missing-sku');
  });

  it('rejects a forbidden product key that is not present in the Seed Catalog', () => {
    const input = loadEvalV2RepositoryInput(repoRoot);
    input.overrides.retrieval.Q05 = {
      ...input.overrides.retrieval.Q05,
      forbiddenProductKeys: ['missing-product'],
    };

    expect(() => compileEvalV2(input)).toThrow('FORBIDDEN_PRODUCT_KEY_INVALID:Q05:missing-product');
  });

  it('keeps both previous canonical files when the second temporary write fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aikefu-eval-v2-'));
    const first = join(directory, 'retrieval.json');
    const secondParent = join(directory, 'missing');
    const second = join(secondParent, 'product.json');
    writeFileSync(first, 'previous-retrieval');
    mkdirSync(join(directory, 'existing'));

    try {
      expect(() => writeEvalV2CanonicalAtomically(compileEvalV2FromRepo(repoRoot), {
        retrieval: first,
        product: second,
      })).toThrow();
      expect(readFileSync(first, 'utf8')).toBe('previous-retrieval');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
