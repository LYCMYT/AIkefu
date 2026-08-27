import { createHash, randomBytes } from 'node:crypto';

const WORKSPACE_TOKEN_PREFIX = 'dws_';
const WORKSPACE_TOKEN_ENTROPY_BYTES = 32;
const BASE64URL_ENTROPY_LENGTH = 43;
const WORKSPACE_TOKEN_PATTERN = new RegExp(
  `^${WORKSPACE_TOKEN_PREFIX}[A-Za-z0-9_-]{${BASE64URL_ENTROPY_LENGTH}}$`,
);

/** Creates an opaque 256-bit token containing no workspace or tenant data. */
export function createWorkspaceToken(): string {
  return `${WORKSPACE_TOKEN_PREFIX}${randomBytes(WORKSPACE_TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}

export function isWorkspaceToken(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_TOKEN_PATTERN.test(value);
}

/**
 * Returns the stable lowercase SHA-256 digest persisted by the API.
 * Rejecting malformed input here prevents accidental database lookups for
 * platform cookies, private tokens, or arbitrary attacker-controlled strings.
 */
export function hashWorkspaceToken(token: string): string {
  if (!isWorkspaceToken(token)) {
    throw new TypeError('Invalid demo workspace token');
  }

  return createHash('sha256').update(token, 'utf8').digest('hex');
}
