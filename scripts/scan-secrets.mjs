import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_RULES = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['GITHUB_TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['OPENAI_KEY', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
];

const EXAMPLE_ENV = /(^|\/)\.env(?:\.[^/]+)?\.example$/i;
const PRIVATE_ENV = /(^|\/)\.env(?:\.[^/]+)?$/i;
const PRIVATE_FILE = /(^|\/)(?:id_rsa|id_ed25519|service-account\.json|credentials\.json)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|p12|pfx|key)$/i;

export function normalizeRepoPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isSensitivePath(value) {
  const path = normalizeRepoPath(value);
  if (EXAMPLE_ENV.test(path)) return false;
  return PRIVATE_ENV.test(path) || PRIVATE_FILE.test(path) || PRIVATE_EXTENSION.test(path);
}

export function findSecretFindings(files) {
  const findings = [];
  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (isSensitivePath(path)) {
      findings.push({ path, rule: 'SENSITIVE_PATH' });
      continue;
    }
    if (file.content.includes('\0')) continue;
    for (const [rule, pattern] of CONTENT_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(file.content)) findings.push({ path, rule });
    }
  }
  return findings;
}

export function trackedFiles(root = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root });
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizeRepoPath);
}

export function scanTrackedFiles(root = process.cwd()) {
  const files = trackedFiles(root).map((path) => ({
    path,
    content: readFileSync(resolve(root, path)).toString('utf8'),
  }));
  return findSecretFindings(files);
}

function isCli() {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isCli()) {
  try {
    const findings = scanTrackedFiles();
    if (findings.length > 0) {
      console.error('Secret scan failed. Potential credentials were found:');
      for (const finding of findings) console.error(`- ${finding.path} (${finding.rule})`);
      process.exitCode = 1;
    } else {
      console.log(`Secret scan passed (${trackedFiles().length} tracked files).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
