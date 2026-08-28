import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

function TypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? TypeScriptFiles(path) : entry.endsWith('.ts') ? [path] : [];
  });
}

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

  it('keeps the API facade thin and its responsibilities in dedicated modules', () => {
    const api = readFileSync(resolve(root, 'apps/web/src/api.ts'), 'utf8');
    expect(api.split(/\r?\n/).length).toBeLessThanOrEqual(600);
    for (const file of [
      'apps/web/src/api/client.ts',
      'apps/web/src/api/types.ts',
      'apps/web/src/api/normalizers.ts',
      'apps/web/src/api/endpoints.ts',
      'apps/web/src/api/endpoints/workflow.ts',
      'apps/web/src/api/normalizers/workflow-governance.ts',
    ]) expect(existsSync(resolve(root, file)), file).toBe(true);

    for (const file of TypeScriptFiles(resolve(root, 'apps/web/src/api'))) {
      expect(readFileSync(file, 'utf8').split(/\r?\n/).length, file).toBeLessThanOrEqual(600);
    }
  });
});
