import ExcelJS from 'exceljs';
import { parseKnowledgeCsv, type ParsedKnowledgeCsv } from './knowledge.policy';

export type KnowledgeImportSource = { csv?: string; xlsx?: Buffer };

/**
 * Reads only literal cell values from the first worksheet. Formulas, macros and
 * external links are not evaluated or retained, so an upload cannot execute
 * spreadsheet logic in the API process.
 */
export async function parseKnowledgeImportSource(source: KnowledgeImportSource): Promise<ParsedKnowledgeCsv> {
  if (source.csv !== undefined) return parseKnowledgeCsv(source.csv);
  if (!source.xlsx) return parseKnowledgeCsv('');

  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4 ships older Buffer declarations than Node 24. Keep the type
  // compatibility boundary local; the runtime value is the original upload
  // buffer and is never executed.
  await (workbook.xlsx as unknown as { load(buffer: unknown): Promise<unknown> }).load(source.xlsx);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return parseKnowledgeCsv('');
  const matrix: string[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells: string[] = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const value = row.getCell(column).value;
      if (isFormula(value)) throw new Error('XLSX_FORMULAS_NOT_ALLOWED');
      cells.push(toCellText(value));
    }
    matrix.push(cells);
  }
  return parseKnowledgeCsv(matrix.map((row) => row.map(csvEscape).join(',')).join('\n'));
}

function isFormula(value: ExcelJS.CellValue): boolean {
  return typeof value === 'object' && value !== null && 'formula' in value;
}

function toCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value) return value.richText.map((entry) => entry.text).join('');
    return '';
  }
  return String(value);
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
