export type ValidatedEnvironment = Readonly<{
  production: boolean;
  apiPort: number;
  webOrigin: string;
  jsonBodyLimit: string;
  attachmentStorageTimeoutMs: number;
}>;

const BOOLEAN_KEYS = [
  'AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN',
  'S3_FORCE_PATH_STYLE',
] as const;

const POSITIVE_INTEGER_KEYS = [
  'AI_TIMEOUT_MS',
  'AI_EMBEDDING_TIMEOUT_MS',
  'ATTACHMENT_STORAGE_TIMEOUT_MS',
] as const;

export function validateEnvironment(environment: Record<string, string | undefined> = process.env): ValidatedEnvironment {
  const errors: string[] = [];
  const nodeEnvironment = environment.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnvironment)) errors.push('NODE_ENV');

  const apiPort = integer(environment.API_PORT ?? '3000', 1, 65_535, 'API_PORT', errors);
  const attachmentStorageTimeoutMs = integer(
    environment.ATTACHMENT_STORAGE_TIMEOUT_MS ?? '8000',
    1,
    60_000,
    'ATTACHMENT_STORAGE_TIMEOUT_MS',
    errors,
  );
  for (const key of POSITIVE_INTEGER_KEYS) {
    if (environment[key] !== undefined) integer(environment[key]!, 1, 120_000, key, errors);
  }
  for (const key of BOOLEAN_KEYS) {
    const value = environment[key];
    if (value !== undefined && value !== 'true' && value !== 'false') errors.push(key);
  }

  const webOrigin = validHttpUrl(environment.WEB_ORIGIN ?? 'http://localhost:5173', 'WEB_ORIGIN', errors);
  for (const key of ['AI_BASE_URL', 'AI_EMBEDDING_BASE_URL', 'S3_ENDPOINT'] as const) {
    const value = environment[key];
    if (value) validHttpUrl(value, key, errors);
  }

  const jsonBodyLimit = environment.JSON_BODY_LIMIT ?? '1mb';
  if (!/^\d+(?:kb|mb)$/i.test(jsonBodyLimit)) errors.push('JSON_BODY_LIMIT');

  if (nodeEnvironment === 'production') {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
      if (!environment[key]?.trim()) errors.push(key);
    }
  }

  if (errors.length > 0) {
    throw new Error(`ENVIRONMENT_INVALID: ${[...new Set(errors)].sort().join(', ')}`);
  }
  return Object.freeze({ production: nodeEnvironment === 'production', apiPort, webOrigin, jsonBodyLimit, attachmentStorageTimeoutMs });
}

function integer(value: string, minimum: number, maximum: number, key: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(key);
    return minimum;
  }
  return parsed;
}

function validHttpUrl(value: string, key: string, errors: string[]): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.includes('*')) throw new Error('invalid');
    return parsed.origin;
  } catch {
    errors.push(key);
    return 'http://localhost';
  }
}
