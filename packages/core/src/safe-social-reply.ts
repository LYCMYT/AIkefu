export type SafeSocialIntent =
  | 'GREETING'
  | 'THANKS'
  | 'GOODBYE'
  | 'ACKNOWLEDGEMENT'
  | 'CAPABILITY';

export type SafeSocialReply = {
  intent: SafeSocialIntent;
  text: string;
};

export type SafeKnowledgeIntent = 'SHIPPING_POLICY';

const exactSocialTurns: Array<{
  intent: SafeSocialIntent;
  pattern: RegExp;
  text: string;
}> = [
  {
    intent: 'GREETING',
    pattern: /^(?:(?:你好|您好|嗨|哈[喽啰])(?:呀|啊|哈)?(?:\s*👋)?|hello|hi|hey|在吗|有人吗|客服在吗|早上好|上午好|中午好|下午好|晚上好|👋)$/iu,
    text: '您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。',
  },
  {
    intent: 'THANKS',
    pattern: /^(?:谢谢|谢谢你|谢谢啦|谢谢哈|多谢|感谢|辛苦了|好的谢谢|好谢谢|thanks|thank you|🙏)$/iu,
    text: '不客气，很高兴帮到您。有其他问题可以继续告诉我。',
  },
  {
    intent: 'GOODBYE',
    pattern: /^(?:再见|拜拜|回头见|晚安|bye|goodbye)$/iu,
    text: '好的，感谢您的咨询，祝您生活愉快。',
  },
  {
    intent: 'ACKNOWLEDGEMENT',
    pattern: /^(?:好的|好呢|好哒|知道了|明白了|了解了|收到|行|可以|没问题|嗯|嗯嗯|ok|okay|👍|👌|😊|🙂)$/iu,
    text: '好的，有需要可以继续告诉我。',
  },
  {
    intent: 'CAPABILITY',
    pattern: /^(?:你是谁|你是机器人吗|你能做什么|你会什么|怎么使用|怎么咨询)$/iu,
    text: '您好，我是本店的 AI 客服，可以协助查询商品、库存、订单、物流和常见售后问题；需要核验或存在风险时会转人工处理。',
  },
];

/**
 * Resolves only an entire, fact-free social turn. Mixed text deliberately
 * falls through to the normal intent, evidence and safety pipeline so a
 * greeting can never hide an order, payment or after-sales request.
 */
export function resolveSafeSocialReply(input: string): SafeSocialReply | undefined {
  const normalized = normalizeTurn(input);
  if (!normalized) return undefined;
  const match = exactSocialTurns.find((entry) => entry.pattern.test(normalized));
  return match ? { intent: match.intent, text: match.text } : undefined;
}

/**
 * Identifies a tiny allow-list of read-only policy questions whose answer must
 * still come from frozen Shop evidence. Operational/order-specific and mixed
 * high-risk text is rejected before intent normalization.
 */
export function resolveSafeKnowledgeIntent(input: string): SafeKnowledgeIntent | undefined {
  const normalized = normalizeTurn(input);
  if (!normalized || /(?:订单|这单|我的|催|退款|退货|换货|改地址|修改地址|取消|赔偿|投诉|支付|付款|人工|偏远|新疆|西藏)/u.test(normalized)) {
    return undefined;
  }
  const question = normalized
    .replace(/^(?:(?:你好|您好|嗨|哈[喽啰])(?:呀|啊|哈)?[，,\s]*)?(?:请问|想问一下|问一下)?\s*/u, '')
    .replace(/[吗呢呀啊]$/u, '')
    .trim();
  return /^(?:(?:普通地区|现货商品|预售商品)?(?:一般|通常|大概|预计)?(?:多久|几天|多长时间|什么时候)(?:能)?发(?:货|出)|发(?:货|出)(?:要|需要)?(?:多久|几天|多长时间)|发什么快递|支持指定快递|(?:是否|支持)?包邮|(?:有|支持)?运费险)$/u.test(question)
    ? 'SHIPPING_POLICY'
    : undefined;
}

function normalizeTurn(input: string): string {
  return input
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s！？?!。．，,～~]+$/gu, '')
    .trim();
}
