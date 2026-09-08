import { loadEvalV2Sources, parseStrictCsv } from '../src/eval-v2/eval-v2.loader';
import { resolve } from 'node:path';

describe('Eval V2 source contract', () => {
  it('loads exactly 40 retrieval rows and 72 product rows with unique IDs', () => {
    const source = loadEvalV2Sources(resolve(__dirname, '../../..'));

    expect(source.retrieval).toHaveLength(40);
    expect(new Set(source.retrieval.map((row) => row.ID)).size).toBe(40);
    expect(source.product).toHaveLength(72);
    expect(new Set(source.product.map((row) => row.ID)).size).toBe(72);
  });

  it('parses BOM, quoted commas, doubled quotes and CRLF without changing cell text', () => {
    const rows = parseStrictCsv<{ ID: string; Query: string }>(
      '\uFEFFID,Query\r\nQ01,"支持, ""Mac"" 吗？"\r\n',
      { label: 'fixture', headers: ['ID', 'Query'], expectedCount: 1 },
    );

    expect(rows).toEqual([{ ID: 'Q01', Query: '支持, "Mac" 吗？' }]);
  });

  it('rejects uneven rows before any case can be consumed', () => {
    expect(() => parseStrictCsv('ID,Query\nQ01', {
      label: 'fixture',
      headers: ['ID', 'Query'],
      expectedCount: 1,
    })).toThrow('CSV_ROW_WIDTH:fixture:2:1/2');
  });

  it('rejects duplicate IDs and unexpected case counts', () => {
    expect(() => parseStrictCsv('ID,Query\nQ01,a\nQ01,b', {
      label: 'fixture',
      headers: ['ID', 'Query'],
      expectedCount: 2,
    })).toThrow('CSV_ID_DUPLICATE:fixture:Q01');
    expect(() => parseStrictCsv('ID,Query\nQ01,a', {
      label: 'fixture',
      headers: ['ID', 'Query'],
      expectedCount: 2,
    })).toThrow('CSV_CASE_COUNT:fixture:1/2');
  });
});
