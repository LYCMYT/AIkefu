import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../../..');
const readRepositoryFile = (relativePath: string) => readFileSync(resolve(repositoryRoot, relativePath), 'utf8');

describe('Customer data controls', () => {
  it('keeps the destructive route and result semantics visible at the Web boundary', () => {
    const api = readRepositoryFile('apps/web/src/api.ts');
    const app = readRepositoryFile('apps/web/src/App.tsx');
    const privacy = readRepositoryFile('apps/web/src/features/privacy/DataPrivacyPage.tsx');

    expect(api).toContain("/buyers/${encodeURIComponent(normalizedBuyerId)}/customer-data");
    expect(api).toContain('deleteCustomerData');
    expect(app).toContain('DataPrivacyPage');
    expect(privacy).toContain('删除客户数据');
    expect(privacy).toContain('输入买家 ID');
    expect(privacy).toContain('二次确认');
  });

  it('surfaces the frozen retention policy without exposing private platform credentials', () => {
    const app = readRepositoryFile('apps/web/src/features/privacy/DataPrivacyPage.tsx');

    expect(app).toContain('聊天原文 · 45 天');
    expect(app).toContain('图片原件 · 15 天');
    expect(app).toContain('ConversationSummary · 90 天');
    expect(app).toContain('CustomerMemory · 人工管理 / expiresAt');
    expect(app).not.toMatch(/(?:sk|ak)-[A-Za-z0-9]{20,}/);
  });
});
