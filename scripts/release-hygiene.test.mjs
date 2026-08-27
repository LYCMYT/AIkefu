import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  findSecretFindings,
  isSensitivePath,
} from './scan-secrets.mjs';
import {
  assertReleaseFileList,
  defaultArchiveName,
} from './create-source-archive.mjs';

test('secret scan rejects credential files and high-confidence token formats', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('config/.env.production'), true);
  assert.equal(isSensitivePath('keys/service-account.json'), true);
  assert.equal(isSensitivePath('.env.example'), false);

  const findings = findSecretFindings([
    { path: 'safe.ts', content: 'export const value = "demo";' },
    { path: 'bad.ts', content: `const token = "${'ghp_' + 'a'.repeat(32)}";` },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, 'bad.ts');
});

test('release archive rejects dependencies, build output, private env and internal references', () => {
  assert.throws(
    () => assertReleaseFileList([
      'README.md',
      '.env.example',
      'apps/api/src/main.ts',
      'node_modules/pkg/index.js',
    ]),
    /FORBIDDEN_RELEASE_PATH/,
  );
  assert.throws(
    () => assertReleaseFileList(['README.md', 'references/private-screenshot.png']),
    /FORBIDDEN_RELEASE_PATH/,
  );
  assert.doesNotThrow(() => assertReleaseFileList([
    'README.md',
    '.env.example',
    '.env.production.example',
    'apps/api/src/main.ts',
  ]));
});

test('archive filename is deterministic for a commit', () => {
  assert.equal(defaultArchiveName('995294025208cd9a53f8b650a26c5d6ddb2fc474'), 'aikefu-source-9952940.zip');
});

test('CI has a non-skipped real infrastructure and browser gate', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /real-infra:/);
  assert.match(workflow, /RUN_REAL_INFRA_INTEGRATION:\s*'1'/);
  assert.match(workflow, /RUN_REAL_INFRA_E2E:\s*'1'/);
  assert.match(workflow, /playwright install --with-deps chromium/);
});
