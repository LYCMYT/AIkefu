import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

describe('frontend module boundaries', () => {
  it('keeps routing/providers and independent Usage/Privacy features outside App.tsx', () => {
    for (const file of [
      'apps/web/src/app/providers.tsx',
      'apps/web/src/app/routes.ts',
      'apps/web/src/features/usage/UsageAdminPage.tsx',
      'apps/web/src/features/privacy/DataPrivacyPage.tsx',
    ]) expect(existsSync(resolve(root, file)), file).toBe(true);

    const app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
    expect(app).not.toContain('function UsageAdminPage');
    expect(app).not.toContain('function DataPrivacyPage');
  });
});
