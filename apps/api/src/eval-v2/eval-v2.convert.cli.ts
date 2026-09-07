import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileEvalV2FromRepo, writeEvalV2CanonicalAtomically } from './eval-v2.converter';

export function runEvalV2Conversion(repoRoot = resolve(__dirname, '../../../..')): {
  retrievalPath: string;
  productPath: string;
  retrievalCount: number;
  productCount: number;
} {
  const canonicalDirectory = resolve(repoRoot, 'evals/canonical');
  const retrievalPath = resolve(canonicalDirectory, 'retrieval-40.v2.json');
  const productPath = resolve(canonicalDirectory, 'product-testset-72.v2.json');
  const bundle = compileEvalV2FromRepo(repoRoot);
  mkdirSync(canonicalDirectory, { recursive: true });
  writeEvalV2CanonicalAtomically(bundle, { retrieval: retrievalPath, product: productPath });
  return {
    retrievalPath,
    productPath,
    retrievalCount: bundle.retrieval.cases.length,
    productCount: bundle.product.cases.length,
  };
}

if (require.main === module) {
  const result = runEvalV2Conversion();
  process.stdout.write(`Eval V2 canonical files written: retrieval=${result.retrievalCount}, product=${result.productCount}\n`);
}
