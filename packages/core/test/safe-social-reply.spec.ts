import { resolveSafeKnowledgeIntent, resolveSafeSocialReply } from '../src/safe-social-reply';

describe('resolveSafeSocialReply', () => {
  it.each([
    ['你好', 'GREETING'],
    ['你好呀 👋', 'GREETING'],
    ['在吗？', 'GREETING'],
    ['谢谢啦', 'THANKS'],
    ['🙏', 'THANKS'],
    ['拜拜', 'GOODBYE'],
    ['收到', 'ACKNOWLEDGEMENT'],
    ['👍', 'ACKNOWLEDGEMENT'],
    ['你能做什么？', 'CAPABILITY'],
  ])('recognizes the exact low-risk social turn %s', (text, intent) => {
    expect(resolveSafeSocialReply(text)).toMatchObject({ intent });
  });

  it.each([
    '你好，请问多久发货？',
    '好的，那就帮我退款',
    '谢谢，订单怎么还没到？',
    '在吗，我要修改收货地址',
    '👋 这件衣服有货吗',
    '可以退款吗？',
    '',
  ])('never consumes a mixed or business-bearing turn: %s', (text) => {
    expect(resolveSafeSocialReply(text)).toBeUndefined();
  });
});

describe('resolveSafeKnowledgeIntent', () => {
  it.each([
    '你好，请问多久发货？',
    '什么时候发货',
    '发货要多久？',
    '发什么快递',
    '支持指定快递吗',
    '是否包邮',
    '有运费险吗',
    '偏远地区多久发货',
    '新疆多久发货',
  ])('recognizes an exact static shipping-policy question: %s', (text) => {
    expect(resolveSafeKnowledgeIntent(text)).toBe('SHIPPING_POLICY');
  });

  it.each([
    '我的订单什么时候发货',
    '催一下发货',
    '改地址后多久发货',
    '我要退款，多久发货',
    '你好，请问多久发货，另外能退款吗',
  ])('never downgrades an operational or mixed-risk question: %s', (text) => {
    expect(resolveSafeKnowledgeIntent(text)).toBeUndefined();
  });
});
