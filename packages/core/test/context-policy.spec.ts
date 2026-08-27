import { buildBudgetedContext, sanitizeContext } from '../src/context-policy';

describe('Context policy', () => {
  it('redacts PII and secrets while reporting only included classes and excluded PII kinds', () => {
    const result = sanitizeContext(
      {
        userTurn: '手机号 13800138000，地址：上海市浦东新区世纪大道 100 号',
        authorization: 'Bearer private-token',
        cookie: 'sid=secret',
        logisticsNumber: 'SF1234567890123',
        relevantFact: '已发货',
      },
      ['userTurn', 'relevantFact', 'logisticsNumber'],
    );

    expect(JSON.stringify(result.value)).not.toContain('13800138000');
    expect(JSON.stringify(result.value)).not.toContain('SF1234567890123');
    expect(result.audit).toEqual({
      includedDataClasses: ['logisticsNumber', 'relevantFact', 'userTurn'],
      excludedPII: ['ADDRESS', 'PHONE', 'TRACKING_NUMBER'],
    });
  });

  it('redacts identity numbers, email addresses, and bank-card-like payment data before provider calls', () => {
    const result = sanitizeContext(
      {
        messages: '身份证 11010519491231002X；邮箱 alice@example.com；银行卡 6222021234567890123；手机号 13800138000',
        nested: { bankCard: '6222 0212 3456 7890 123', note: '正常内容' },
      },
      ['messages', 'nested'],
    );

    const rendered = JSON.stringify(result.value);
    expect(rendered).not.toContain('11010519491231002X');
    expect(rendered).not.toContain('alice@example.com');
    expect(rendered).not.toContain('6222021234567890123');
    expect(rendered).not.toContain('13800138000');
    expect(rendered).not.toContain('6222 0212 3456 7890 123');
    expect(rendered).toContain('正常内容');
    expect(result.audit.excludedPII).toEqual(['BANK_CARD', 'EMAIL', 'ID_NUMBER', 'PHONE']);
  });

  it('drops low-priority context first and always preserves P0', () => {
    const result = buildBudgetedContext(
      [
        { id: 'system', priority: 0, tokens: 30, value: 'rules' },
        { id: 'facts', priority: 1, tokens: 30, value: 'facts' },
        { id: 'recent', priority: 3, tokens: 30, value: 'recent' },
        { id: 'summary', priority: 5, tokens: 30, value: 'summary' },
        { id: 'memory', priority: 6, tokens: 30, value: 'memory' },
      ],
      90,
    );

    expect(result.included.map((item) => item.id)).toEqual(['system', 'facts', 'recent']);
    expect(result.dropped.map((item) => item.id)).toEqual(['summary', 'memory']);
  });
});
