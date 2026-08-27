import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSensitivePath, normalizeRepoPath, scanTrackedFiles, trackedFiles } from './scan-secrets.mjs';

const FORBIDDEN_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  '.npm-cache',
  '.pnpm-store',
  '.obsidian',
  'references',
  'release-artifacts',
]);

export function forbiddenReleaseReason(value) {
  const path = normalizeRepoPath(value);
  if (isSensitivePath(path)) return 'sensitive path';
  const segments = path.split('/');
  const segment = segments.find((part) => FORBIDDEN_SEGMENTS.has(part));
  return segment ? `forbidden directory ${segment}` : null;
}

export function assertReleaseFileList(files) {
  for (const file of files) {
    const reason = forbiddenReleaseReason(file);
    if (reason) throw new Error(`FORBIDDEN_RELEASE_PATH: ${normalizeRepoPath(file)} (${reason})`);
  }
}

export function defaultArchiveName(commit) {
  const revision = String(commit).trim();
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('ARCHIVE_COMMIT_INVALID');
  return `aikefu-source-${revision.slice(0, 7).toLowerCase()}.zip`;
}

export function createSourceArchive({ root = process.cwd(), output } = {}) {
  const files = trackedFiles(root);
  assertReleaseFileList(files);
  const findings = scanTrackedFiles(root);
  if (findings.length > 0) throw new Error(`SECRET_SCAN_FAILED: ${findings.map((item) => item.path).join(', ')}`);

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (status) throw new Error('WORKTREE_NOT_CLEAN: commit or stash changes before creating a release archive');

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const archive = resolve(root, output ?? `release-artifacts/${defaultArchiveName(commit)}`);
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync('git', ['archive', '--format=zip', `--output=${archive}`, 'HEAD'], { cwd: root, stdio: 'inherit' });
  return { archive, fileCount: files.length, commit };
}

function isCli() {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isCli()) {
  try {
    const result = createSourceArchive({ output: process.argv[2] });
    console.log(`Created ${basename(result.archive)} from ${result.commit.slice(0, 7)} (${result.fileCount} tracked files).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
