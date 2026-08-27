export type ContextAudit = {
  includedDataClasses: string[];
  excludedPII: Array<'ADDRESS' | 'BANK_CARD' | 'EMAIL' | 'ID_NUMBER' | 'PHONE' | 'TRACKING_NUMBER'>;
};

export type SanitizedContext = {
  value: Record<string, unknown>;
  audit: ContextAudit;
};

const SECRET_KEYS = /authorization|cookie|token|secret|password|payment/i;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const TRACKING = /\b(?:SF|YT|ZTO|STO|JD|EMS)[A-Z0-9]{8,20}\b/gi;
const ADDRESS = /地址\s*[:：]\s*[^,，。\n]+/g;
const ID_NUMBER = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANK_CARD = /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g;
const PII_KEYS: Array<[RegExp, ContextAudit['excludedPII'][number]]> = [
  [/identity|idcard|id_number|身份证/i, 'ID_NUMBER'],
  [/e-?mail|邮箱/i, 'EMAIL'],
  [/bank.*card|card.*number|银行卡|payment.*account/i, 'BANK_CARD'],
  [/phone|mobile|手机号/i, 'PHONE'],
  [/address|地址/i, 'ADDRESS'],
];

export function sanitizeContext(input: Record<string, unknown>, allowedDataClasses: readonly string[]): SanitizedContext {
  const allowed = new Set(allowedDataClasses);
  const excluded = new Set<ContextAudit['excludedPII'][number]>();
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key) || SECRET_KEYS.test(key)) continue;
    const keyKind = piiKindForKey(key);
    if (keyKind) {
      excluded.add(keyKind);
      continue;
    }
    value[key] = sanitizeValue(input[key], excluded);
  }
  return {
    value,
    audit: {
      includedDataClasses: Object.keys(value).sort(),
      excludedPII: [...excluded].sort(),
    },
  };
}

function sanitizeValue(value: unknown, excluded: Set<ContextAudit['excludedPII'][number]>): unknown {
  if (typeof value === 'string') {
    let sanitized = value;
    if (ID_NUMBER.test(sanitized)) {
      excluded.add('ID_NUMBER');
      sanitized = sanitized.replace(ID_NUMBER, '[REDACTED_ID_NUMBER]');
    }
    ID_NUMBER.lastIndex = 0;
    if (EMAIL.test(sanitized)) {
      excluded.add('EMAIL');
      sanitized = sanitized.replace(EMAIL, '[REDACTED_EMAIL]');
    }
    EMAIL.lastIndex = 0;
    if (BANK_CARD.test(sanitized)) {
      excluded.add('BANK_CARD');
      sanitized = sanitized.replace(BANK_CARD, '[REDACTED_BANK_CARD]');
    }
    BANK_CARD.lastIndex = 0;
    if (PHONE.test(sanitized)) {
      excluded.add('PHONE');
      sanitized = sanitized.replace(PHONE, '[REDACTED_PHONE]');
    }
    PHONE.lastIndex = 0;
    if (TRACKING.test(sanitized)) {
      excluded.add('TRACKING_NUMBER');
      sanitized = sanitized.replace(TRACKING, '[REDACTED_TRACKING_NUMBER]');
    }
    TRACKING.lastIndex = 0;
    if (ADDRESS.test(sanitized)) {
      excluded.add('ADDRESS');
      sanitized = sanitized.replace(ADDRESS, '地址：[REDACTED_ADDRESS]');
    }
    ADDRESS.lastIndex = 0;
    return sanitized;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, excluded));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key)) continue;
      const keyKind = piiKindForKey(key);
      if (keyKind) {
        excluded.add(keyKind);
        continue;
      }
      result[key] = sanitizeValue(nested, excluded);
    }
    return result;
  }
  return value;
}

function piiKindForKey(key: string): ContextAudit['excludedPII'][number] | undefined {
  return PII_KEYS.find(([pattern]) => pattern.test(key))?.[1];
}

export type ContextBudgetItem<T = unknown> = {
  id: string;
  priority: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  tokens: number;
  value: T;
};

export function buildBudgetedContext<T>(items: readonly ContextBudgetItem<T>[], tokenBudget: number): {
  included: ContextBudgetItem<T>[];
  dropped: ContextBudgetItem<T>[];
  usedTokens: number;
} {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) throw new RangeError('tokenBudget must be non-negative');
  const ordered = items.map((item, index) => ({ item, index })).sort(
    (left, right) => left.item.priority - right.item.priority || left.index - right.index,
  );
  const included: ContextBudgetItem<T>[] = [];
  const dropped: ContextBudgetItem<T>[] = [];
  let usedTokens = 0;
  for (const { item } of ordered) {
    if (!Number.isFinite(item.tokens) || item.tokens < 0) throw new RangeError(`Invalid token estimate for ${item.id}`);
    if (item.priority === 0 || usedTokens + item.tokens <= tokenBudget) {
      included.push(item);
      usedTokens += item.tokens;
    } else {
      dropped.push(item);
    }
  }
  return { included, dropped, usedTokens };
}
