import {
  buildReplyContext,
  guardReplyOutput,
  isTaskBlocking,
  renderCustomerFactReply,
} from '../src/reply-quality';

describe('reply quality primitives', () => {
  it('keeps high-priority live context and trims lower-priority memory within budget', () => {
    const result = buildReplyContext({
      maxCharacters: 520,
      currentTurn: { text: '那白色呢？' },
      tasks: [{ intent: 'INVENTORY_QUERY' }],
      realtimeFacts: [{ inventory: 2, color: '白色' }],
      evidence: [{ answer: '白色款为常规在售颜色。' }],
      recentMessages: [
        { role: 'BUYER', text: '黑色 XL 还有吗？', sequence: 10 },
        { role: 'ASSISTANT', text: '黑色 XL 有现货。', sequence: 11 },
      ],
      structuredFacts: { preferredSize: 'XL' },
      summary: { narrative: '买家正在比较颜色。' },
      customerMemory: Array.from({ length: 20 }, (_, index) => ({ key: `memory-${index}`, value: 'x'.repeat(80) })),
    });

    expect(result.context).toMatchObject({
      turn: { text: '那白色呢？' },
      tasks: [{ intent: 'INVENTORY_QUERY' }],
      realtimeFacts: [{ inventory: 2, color: '白色' }],
      evidence: [{ answer: '白色款为常规在售颜色。' }],
    });
    expect(result.context.recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '黑色 XL 还有吗？' }),
    ]));
    expect(result.characterCount).toBeLessThanOrEqual(520);
    expect(result.truncatedSections).toContain('customerMemory');
    expect((result.context.customerMemory as unknown[]).length).toBeLessThan(20);
  });

  it('does not treat safe READ tools as blocking actions', () => {
    expect(isTaskBlocking(['GET_INVENTORY'], 'LOW')).toBe(false);
    expect(isTaskBlocking(['GET_ORDER', 'GET_LOGISTICS'], 'MEDIUM')).toBe(false);
    expect(isTaskBlocking(['ADD_ORDER_REMARK'], 'LOW')).toBe(true);
    expect(isTaskBlocking(['PROPOSE_COMPENSATION'], 'LOW')).toBe(true);
  });

  it('keeps the highest-ranked evidence and shop policy instead of dropping a large grounded section', () => {
    const result = buildReplyContext({
      maxCharacters: 700,
      currentTurn: { text: '怎么洗？' },
      tasks: [{ intent: 'PRODUCT_QUERY' }],
      evidence: [
        { versionId: 'best', answer: '建议手洗。' },
        { versionId: 'second', answer: 'x'.repeat(900) },
        { versionId: 'third', answer: 'y'.repeat(900) },
      ],
      shopSettings: { tone: '亲切简洁', afterSalesPolicy: '售后需人工确认。' },
      recentMessages: Array.from({ length: 10 }, (_, sequence) => ({ sequence, text: 'z'.repeat(80) })),
    });

    expect(result.context.evidence).toEqual([{ versionId: 'best', answer: '建议手洗。' }]);
    expect(result.context.shopSettings).toEqual({ tone: '亲切简洁', afterSalesPolicy: '售后需人工确认。' });
    expect(result.characterCount).toBeLessThanOrEqual(700);
  });

  it('fails closed on false action claims, PII, internal traces and mismatched inventory', () => {
    expect(guardReplyOutput({ text: '已为您退款成功。', taskResults: [] })).toMatchObject({ allowed: false, reason: 'ACTION_WITHOUT_RECEIPT' });
    expect(guardReplyOutput({ text: '请联系 13800138000。', taskResults: [] })).toMatchObject({ allowed: false, reason: 'PII_LEAK' });
    expect(guardReplyOutput({ text: 'Developer Trace: abc', taskResults: [] })).toMatchObject({ allowed: false, reason: 'INTERNAL_LEAK' });
    expect(guardReplyOutput({
      text: '当前库存还有 8 件。',
      taskResults: [{ intent: 'INVENTORY_QUERY', facts: { inventory: 2 } }],
    })).toMatchObject({ allowed: false, reason: 'FACT_MISMATCH' });
    expect(guardReplyOutput({
      text: '退款已提交。',
      taskResults: [{ intent: 'REFUND_REQUEST', facts: { receipt: { status: 'SUCCEEDED' } } }],
    })).toMatchObject({ allowed: true });
  });

  it('renders internal order/inventory facts as customer language without exposing IDs or exact stock', () => {
    expect(renderCustomerFactReply('ORDER_QUERY', {
      externalOrderId: 'ORDER-SECRET-1', status: 'SHIPPED', logistics: { trackingNumber: 'TRACK-SECRET-1' },
    })).toBe('这笔订单已经发货，请留意物流更新。');
    expect(renderCustomerFactReply('INVENTORY_QUERY', {
      externalSkuId: 'SKU-SECRET-1', inventory: 2,
    })).toBe('这个规格目前库存较少，建议尽快下单。');
  });
});
