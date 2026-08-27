import { createHash, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export type PutObjectInput = {
  key: string;
  body: Buffer;
  contentType: string;
};

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(key: string): Promise<void>;
  createSignedReadUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export type AttachmentStorage = ObjectStorage;

export type InMemoryStoredObject = {
  body: Buffer;
  contentType: string;
};

type SignedObject = {
  key: string;
  expiresAt: number;
};

/**
 * Deterministic storage double.  It never exposes the underlying key in the
 * signed URL, which makes accidental key/tenant coupling visible in tests.
 */
@Injectable()
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, InMemoryStoredObject>();
  private readonly signed = new Map<string, SignedObject>();
  private readonly secret: string;
  private readonly now: () => Date;

  constructor(options: { secret?: string; now?: () => Date } = {}) {
    this.secret = options.secret ?? 'attachment-in-memory-test-secret';
    this.now = options.now ?? (() => new Date());
  }

  async putObject(input: PutObjectInput): Promise<void> {
    this.objects.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    for (const [token, signed] of this.signed) {
      if (signed.key === key) this.signed.delete(token);
    }
  }

  async createSignedReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(key)) throw new Error('ATTACHMENT_OBJECT_NOT_FOUND');
    const ttl = boundedTtl(expiresInSeconds);
    const expiresAt = Math.floor(this.now().getTime() / 1000) + ttl;
    const token = createHmac('sha256', this.secret)
      .update(`${key}\n${expiresAt}`)
      .digest('base64url');
    this.signed.set(token, { key, expiresAt });
    return `https://in-memory.invalid/signed/${token}?expiresAt=${expiresAt}`;
  }

  /** Return opaque object keys for assertions in unit tests. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Resolve a test URL without making a network call. */
  resolve(url: string, now = this.now().getTime()): Buffer | undefined {
    let token: string;
    try {
      const parsed = new URL(url);
      token = parsed.pathname.split('/').pop() ?? '';
      const entry = this.signed.get(token);
      if (!entry || entry.expiresAt * 1000 <= now) return undefined;
      const expected = createHmac('sha256', this.secret)
        .update(`${entry.key}\n${entry.expiresAt}`)
        .digest('base64url');
      if (expected !== token) return undefined;
      const object = this.objects.get(entry.key);
      return object ? Buffer.from(object.body) : undefined;
    } catch {
      return undefined;
    }
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

export type MinioStorageConfig = {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
};

/**
 * Small S3 Signature V4 client for MinIO.  Credentials are read only from
 * server configuration and are never accepted from a request or included in
 * application logs.  The implementation intentionally covers only the three
 * operations this bounded attachment feature needs.
 */
@Injectable()
export class MinioObjectStorage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly forcePathStyle: boolean;

  constructor(config: MinioStorageConfig = MinioObjectStorage.configFromEnv()) {
    this.endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.region = config.region ?? 'us-east-1';
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.forcePathStyle = config.forcePathStyle ?? true;
  }

  static fromEnv(): MinioObjectStorage {
    return new MinioObjectStorage(MinioObjectStorage.configFromEnv());
  }

  async putObject(input: PutObjectInput): Promise<void> {
    this.requireCredentials();
    const bodyHash = sha256(input.body);
    const request = this.signedRequest('PUT', input.key, bodyHash, {
      'content-type': input.contentType,
      'content-length': String(input.body.byteLength),
      'x-amz-content-sha256': bodyHash,
    });
    const response = await requestFetch(request.url, {
      method: 'PUT',
      headers: request.headers,
      body: input.body,
    });
    if (response.status === 404) {
      // The local compose file intentionally starts a blank MinIO volume.
      // Create the configured bucket on first use; a concurrent creator's
      // 409 is treated as success by createBucket.
      await this.createBucket();
      const retry = this.signedRequest('PUT', input.key, bodyHash, {
        'content-type': input.contentType,
        'content-length': String(input.body.byteLength),
        'x-amz-content-sha256': bodyHash,
      });
      const retryResponse = await requestFetch(retry.url, {
        method: 'PUT',
        headers: retry.headers,
        body: input.body,
      });
      await ensureSuccess(retryResponse, 'put');
      return;
    }
    await ensureSuccess(response, 'put');
  }

  async deleteObject(key: string): Promise<void> {
    this.requireCredentials();
    const bodyHash = sha256(Buffer.alloc(0));
    const request = this.signedRequest('DELETE', key, bodyHash, {
      'x-amz-content-sha256': bodyHash,
    });
    const response = await requestFetch(request.url, { method: 'DELETE', headers: request.headers });
    await ensureSuccess(response, 'delete');
  }

  async createSignedReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    this.requireCredentials();
    const ttl = boundedTtl(expiresInSeconds);
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const shortDate = amzDate.slice(0, 8);
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const host = this.objectHost();
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId!}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(ttl),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalRequest = [
      'GET',
      this.objectPath(key),
      canonicalQuery(query),
      // SigV4 requires the canonical-headers block to end in a newline;
      // join() then contributes the second newline before SignedHeaders.
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const signature = signatureFor(this.secretAccessKey!, shortDate, this.region, canonicalRequest, amzDate);
    query['X-Amz-Signature'] = signature;
    return `${this.objectOrigin()}${this.objectPath(key)}?${canonicalQuery(query)}`;
  }

  private signedRequest(
    method: 'PUT' | 'DELETE',
    key: string,
    bodyHash: string,
    extraHeaders: Record<string, string>,
    path = this.objectPath(key),
  ): { url: string; headers: Record<string, string> } {
    const now = new Date();
    const amzDate = amzTimestamp(now);
    const shortDate = amzDate.slice(0, 8);
    const host = this.objectHost();
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    const signedHeaders = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = `${signedHeaders.map((name) => `${name}:${normalizeHeader(headers[name]!)}`).join('\n')}\n`;
    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders,
      signedHeaders.join(';'),
      bodyHash,
    ].join('\n');
    const signature = signatureFor(this.secretAccessKey!, shortDate, this.region, canonicalRequest, amzDate);
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId!}/${shortDate}/${this.region}/s3/aws4_request, ` +
      `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
    return { url: `${this.objectOrigin()}${path}`, headers };
  }

  private async createBucket(): Promise<void> {
    const bodyHash = sha256(Buffer.alloc(0));
    const request = this.signedRequest('PUT', '', bodyHash, { 'x-amz-content-sha256': bodyHash }, this.bucketPath());
    const response = await requestFetch(request.url, { method: 'PUT', headers: request.headers });
    if (response.ok || response.status === 409) return;
    await ensureSuccess(response, 'bucket_create');
  }

  private objectHost(): string {
    if (!this.forcePathStyle) return `${this.bucket}.${this.endpoint.host}`;
    return this.endpoint.host;
  }

  private objectOrigin(): string {
    if (this.forcePathStyle) return this.endpoint.origin;
    return `${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}`;
  }

  private objectPath(key: string): string {
    const prefix = this.endpoint.pathname.replace(/\/+$/, '');
    if (!key) return this.bucketPath();
    const encodedKey = key.split('/').map(encodeRfc3986).join('/');
    if (this.forcePathStyle) return `${prefix}/${encodeRfc3986(this.bucket)}/${encodedKey}`;
    return `${prefix}/${encodedKey}`;
  }

  private bucketPath(): string {
    const prefix = this.endpoint.pathname.replace(/\/+$/, '');
    return `${prefix}/${encodeRfc3986(this.bucket)}`;
  }

  private requireCredentials(): void {
    if (!this.accessKeyId || !this.secretAccessKey || !this.bucket) {
      throw new Error('ATTACHMENT_STORAGE_NOT_CONFIGURED');
    }
  }

  private static configFromEnv(): MinioStorageConfig {
    return {
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      bucket: process.env.S3_BUCKET ?? 'ai-customer-service-demo',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    };
  }
}

// Short aliases keep the adapter easy to consume from tests and future
// modules without exposing a second implementation.
export { MinioObjectStorage as MinioStorage, InMemoryObjectStorage as InMemoryStorage };

function boundedTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ATTACHMENT_SIGNED_URL_TTL_INVALID');
  return Math.max(1, Math.min(Math.floor(seconds), 300));
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key]!)}`)
    .join('&');
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function signatureFor(secret: string, shortDate: string, region: string, canonicalRequest: string, amzDate: string): string {
  const scope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${secret}`, shortDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

async function requestFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer },
): Promise<FetchResponse> {
  const fetchFn = globalThis.fetch as unknown as (requestUrl: string, options: unknown) => Promise<FetchResponse>;
  if (typeof fetchFn !== 'function') throw new Error('ATTACHMENT_FETCH_UNAVAILABLE');
  return fetchFn(url, init);
}

async function ensureSuccess(response: FetchResponse, operation: string): Promise<void> {
  if (response.ok) return;
  // Do not include MinIO response bodies: they may contain bucket/key details.
  void response.text().catch(() => undefined);
  throw new Error(`ATTACHMENT_STORAGE_${operation.toUpperCase()}_FAILED_${response.status}`);
}
