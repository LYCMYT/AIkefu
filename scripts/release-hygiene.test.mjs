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
  const historicalReleaseNotes = readFileSync(new URL('../docs/RELEASE_V1.0.0_DEMO.md', import.meta.url), 'utf8');
  const releaseNotes = readFileSync(new URL('../docs/RELEASE_V1.1.0_DEMO.md', import.meta.url), 'utf8');
  const resumeCopy = readFileSync(new URL('../docs/PORTFOLIO_RESUME_COPY.md', import.meta.url), 'utf8');
  const publicDemoChecklist = readFileSync(new URL('../docs/PUBLIC_DEMO_CHECKLIST.md', import.meta.url), 'utf8');
  const showcaseEvidence = readFileSync(new URL('../artifacts/showcase/SHOWCASE_EVIDENCE.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  const unitCount = (content, label) => {
    const match = content.match(/(\d+)\s*\/\s*\1[^\n]*(?:单元测试|Unit)|(?:单元测试|Unit)[^\n]*(\d+)\s*\/\s*\2/i);
    assert.ok(match, `${label} must contain a passing Unit count`);
    return Number(match[1] ?? match[2]);
  };

  assert.match(historicalReleaseNotes, /^# AIkefu v1\.0\.0-demo/m);
  assert.match(historicalReleaseNotes, /647 \/ 647/);
  assert.match(releaseNotes, /^# AIkefu v1\.1\.0-demo$/m);
  assert.match(readme, /releases\/tag\/v1\.1\.0-demo/);
  assert.match(readme, /releases\/download\/v1\.1\.0-demo\/aikefu-3min-demo\.mp4/);
  for (const [label, content] of [['release notes', releaseNotes], ['README', readme], ['resume copy', resumeCopy], ['public checklist', publicDemoChecklist], ['showcase evidence', showcaseEvidence]]) {
    assert.match(content, /v1\.1\.0-demo/, `${label} must identify the v1.1 release`);
    assert.doesNotMatch(content, /本地候选|尚未发布|未发布/, `${label} must use formal release wording`);
  }
  assert.doesNotMatch(readme, /public demo[^\n]*https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  const unitCounts = [unitCount(readme, 'README'), unitCount(releaseNotes, 'release notes'), unitCount(resumeCopy, 'resume copy')];
  assert.ok(unitCounts.every((count) => count === unitCounts[0]), 'Unit count must stay aligned across release documents');
  assert.deepEqual(unitCounts, [694, 694, 694]);
  assert.match(releaseNotes, /63 \/ 63/);
  assert.match(resumeCopy, /63 \/ 63/);
  assert.match(releaseNotes, /25 项录制时间线/);
  assert.match(releaseNotes, /27 (?:个|项)唯一/);
  assert.match(releaseNotes, /真实环境[^\n]*23 passed[^\n]*4 skipped[^\n]*0 failed/);
  assert.match(releaseNotes, /离线(?:模式|环境)[^\n]*6 passed[^\n]*21 skipped[^\n]*0 failed/);
  assert.match(releaseNotes, /1920×1080/);
  assert.match(releaseNotes, /30\s*fps/i);
  assert.match(releaseNotes, /zh-CN-XiaoxiaoNeural/);
  assert.match(releaseNotes, /\+50%/);
  assert.match(releaseNotes, /26 (?:条|个|项)[^\n]*(?:cue|字幕)/i);
  assert.match(releaseNotes, /硬字幕[^\n]*外部 SRT[^\n]*(?:无软字幕轨|不含软字幕轨)/i);
  assert.match(releaseNotes, /13,831,390 bytes/);
  assert.match(releaseNotes, /E64D832B7C67896424C13FAE785837545B89005BD172E500373CDD4E3564435C/i);
  assert.match(releaseNotes, /SC01[–-]SC06/);
  assert.match(publicDemoChecklist, /releases\/tag\/v1\.1\.0-demo/);
  assert.match(showcaseEvidence, /releases\/download\/v1\.1\.0-demo\/aikefu-3min-demo\.mp4/);
  assert.match(releaseNotes, /actions[^\n]*(?:核验|状态)/i);
  assert.doesNotMatch(releaseNotes, /GitHub Actions[^\n]*(?:全部通过|均通过|成功)/i);
  assert.doesNotMatch(releaseNotes, /GHCR[^\n]*(?:已发布|成功)/i);
  assert.match(releaseNotes, /MockDouyin/i);
  assert.match(resumeCopy, /Evidence/);
  assert.match(resumeCopy, /SendGuard/);

  assert.equal(packageJson.scripts['legacy:demo:record'], 'node scripts/record-demo.mjs');
  assert.equal(packageJson.scripts['legacy:demo:voiceover'], 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/generate-demo-voiceover.ps1');
  assert.equal(packageJson.scripts['legacy:demo:build'], 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-demo-video.ps1');
  assert.equal(packageJson.scripts['demo:record'], 'pnpm showcase:record');
  assert.equal(packageJson.scripts['demo:voiceover'], 'pnpm showcase:voice');
  assert.equal(packageJson.scripts['demo:build'], 'pnpm showcase:build');
  assert.equal(packageJson.scripts['showcase:video'], 'pnpm showcase:record && pnpm showcase:build');
});
