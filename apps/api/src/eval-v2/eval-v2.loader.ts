import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRODUCT_CSV_HEADERS,
  RETRIEVAL_CSV_HEADERS,
  type EvalV2SourceBundle,
  type ProductCsvRow,
  type RetrievalCsvRow,
} from './eval-v2.types';

type StrictCsvOptions = {
  label: string;
  headers: readonly string[];
  expectedCount: number;
};

export function parseStrictCsv<T extends Record<string, string>>(
  source: string,
  options: StrictCsvOptions,
): T[] {
  const matrix = parseCsvMatrix(source.replace(/^\uFEFF/, ''));
  if (matrix.length === 0) throw new Error(`CSV_HEADER_MISSING:${options.label}`);
  const actualHeaders = matrix[0]!;
  const duplicateHeader = actualHeaders.find((header, index) => actualHeaders.indexOf(header) !== index);
  if (duplicateHeader) throw new Error(`CSV_HEADER_DUPLICATE:${options.label}:${duplicateHeader}`);
  if (actualHeaders.length !== options.headers.length || actualHeaders.some((header, index) => header !== options.headers[index])) {
    throw new Error(`CSV_HEADERS_INVALID:${options.label}:${actualHeaders.join('|')}`);
  }

  const rows: T[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index]!;
    if (values.length === 1 && values[0] === '' && index === matrix.length - 1) continue;
    if (values.length !== options.headers.length) {
      throw new Error(`CSV_ROW_WIDTH:${options.label}:${index + 1}:${values.length}/${options.headers.length}`);
    }
    const row = Object.fromEntries(options.headers.map((header, column) => [header, values[column]!])) as T;
    const id = row.ID?.trim();
    if (!id) throw new Error(`CSV_ID_REQUIRED:${options.label}:${index + 1}`);
    if (ids.has(id)) throw new Error(`CSV_ID_DUPLICATE:${options.label}:${id}`);
    ids.add(id);
    rows.push(row);
  }
  if (rows.length !== options.expectedCount) {
    throw new Error(`CSV_CASE_COUNT:${options.label}:${rows.length}/${options.expectedCount}`);
  }
  return rows;
}

export function loadEvalV2Sources(repoRoot: string): EvalV2SourceBundle {
  const paths = {
    retrieval: resolve(repoRoot, 'evals/source/retrieval-40.v1.csv'),
    product: resolve(repoRoot, 'evals/source/product-testset-72.v1.csv'),
  };
  return {
    paths,
    retrieval: parseStrictCsv<RetrievalCsvRow>(readFileSync(paths.retrieval, 'utf8'), {
      label: 'retrieval-40.v1',
      headers: RETRIEVAL_CSV_HEADERS,
      expectedCount: 40,
    }),
    product: parseStrictCsv<ProductCsvRow>(readFileSync(paths.product, 'utf8'), {
      label: 'product-testset-72.v1',
      headers: PRODUCT_CSV_HEADERS,
      expectedCount: 72,
    }),
  };
}

function parseCsvMatrix(source: string): string[][] {
  if (source.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) throw new Error(`CSV_QUOTE_INVALID:${rows.length + 1}:${row.length + 1}`);
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error(`CSV_QUOTE_UNCLOSED:${rows.length + 1}:${row.length + 1}`);
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
