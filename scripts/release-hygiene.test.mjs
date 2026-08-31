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
  assert.match(workflow, /RUN_REAL_INFRA_INTEGRATION:\s*'0'[\s\S]*S3_ACCESS_KEY:\s*ci-demo-access[\s\S]*S3_SECRET_KEY:\s*ci-demo-secret/);
  assert.match(workflow, /RUN_REAL_INFRA_INTEGRATION:\s*'1'/);
  assert.match(workflow, /RUN_REAL_INFRA_E2E:\s*'1'/);
  assert.match(workflow, /Build workspace libraries for runtime tests[\s\S]*@ai-customer-service\/contracts build[\s\S]*@ai-customer-service\/core build[\s\S]*@ai-customer-service\/mock-douyin build/);
  assert.match(workflow, /playwright install --with-deps chromium/);
});

test('portfolio release documentation is complete and does not advertise localhost as public', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const releaseNotes = readFileSync(new URL('../docs/RELEASE_V1.0.0_DEMO.md', import.meta.url), 'utf8');
  const resumeCopy = readFileSync(new URL('../docs/PORTFOLIO_RESUME_COPY.md', import.meta.url), 'utf8');

  assert.match(readme, /v1\.0\.0-demo/);
  assert.match(readme, /releases\/download\/v1\.0\.0-demo\/aikefu-3min-demo\.mp4/);
  assert.doesNotMatch(readme, /public demo[^\n]*https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  assert.match(releaseNotes, /647 \/ 647/);
  assert.match(releaseNotes, /61 \/ 61/);
  assert.match(releaseNotes, /MockDouyin/i);
  assert.match(resumeCopy, /Evidence/);
  assert.match(resumeCopy, /SendGuard/);
});
