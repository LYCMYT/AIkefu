import ExcelJS from 'exceljs';
import { parseKnowledgeImportSource } from '../src/knowledge/knowledge.import-source';

describe('knowledge XLSX import source', () => {
  it('reads literal cells from the first worksheet through the same CSV policy shape', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('knowledge');
    sheet.addRow(['product_id', 'question', 'answer']);
    sheet.addRow(['p-1', '可以机洗吗？', '建议轻柔模式']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseKnowledgeImportSource({ xlsx })).resolves.toMatchObject({
      headers: ['product_id', 'question', 'answer'],
      rows: [{ productExternalId: 'p-1', scope: 'PRODUCT', question: '可以机洗吗？', answer: '建议轻柔模式' }],
    });
  });

  it('rejects formulas instead of evaluating spreadsheet code', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('knowledge');
    sheet.addRow(['product_id', 'question', 'answer']);
    sheet.addRow(['p-1', { formula: 'CONCAT("x", "y")' }, 'answer']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseKnowledgeImportSource({ xlsx })).rejects.toThrow('XLSX_FORMULAS_NOT_ALLOWED');
  });
});
