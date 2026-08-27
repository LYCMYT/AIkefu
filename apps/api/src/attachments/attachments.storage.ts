import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  requestTimeoutMs?: number;
  client?: S3Client;
};

type StorageCommand = PutObjectCommand | DeleteObjectCommand | CreateBucketCommand;

/**
 * Official AWS SDK v3 adapter for MinIO/S3. Credentials are server-only and
 * every network operation has a hard deadline even when a custom transport
 * ignores AbortSignal.
 */
@Injectable()
export class MinioObjectStorage implements ObjectStorage {
  private readonly bucket: string;
  private readonly requestTimeoutMs: number;
  private readonly client: S3Client;

  constructor(config: MinioStorageConfig = MinioObjectStorage.configFromEnv()) {
    this.bucket = config.bucket;
    this.requestTimeoutMs = boundedRequestTimeout(config.requestTimeoutMs ?? 8_000);
    if (!this.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error('ATTACHMENT_STORAGE_NOT_CONFIGURED');
    this.client = config.client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      maxAttempts: 1,
    });
  }

  static fromEnv(): MinioObjectStorage {
    return new MinioObjectStorage(MinioObjectStorage.configFromEnv());
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const command = () => new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.body.byteLength,
    });
    try {
      await this.sendWithDeadline(command());
    } catch (error) {
      if (!httpStatus(error, 404)) throw storageFailure('PUT', error);
      await this.createBucket();
      try {
        await this.sendWithDeadline(command());
      } catch (retryError) {
        throw storageFailure('PUT', retryError);
      }
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.sendWithDeadline(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw storageFailure('DELETE', error);
    }
  }

  async createSignedReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const ttl = boundedTtl(expiresInSeconds);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl });
  }

  private async createBucket(): Promise<void> {
    try {
      await this.sendWithDeadline(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!httpStatus(error, 409)) throw storageFailure('BUCKET_CREATE', error);
    }
  }

  private async sendWithDeadline(command: StorageCommand): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const send = this.client.send.bind(this.client) as unknown as (
      storageCommand: StorageCommand,
      options: { abortSignal: AbortSignal },
    ) => Promise<unknown>;
    try {
      return await Promise.race([
        send(command, { abortSignal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('ATTACHMENT_STORAGE_TIMEOUT')), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
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
      requestTimeoutMs: Number(process.env.ATTACHMENT_STORAGE_TIMEOUT_MS || 8_000),
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

function boundedRequestTimeout(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new Error('ATTACHMENT_STORAGE_TIMEOUT_INVALID');
  }
  return milliseconds;
}

function httpStatus(error: unknown, expected: number): boolean {
  return typeof error === 'object'
    && error !== null
    && '$metadata' in error
    && typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 'number'
    && (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === expected;
}

function storageFailure(operation: string, error: unknown): Error {
  if (error instanceof Error && error.message === 'ATTACHMENT_STORAGE_TIMEOUT') return error;
  const status = typeof error === 'object' && error !== null && '$metadata' in error
    ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
    : undefined;
  return new Error(`ATTACHMENT_STORAGE_${operation}_FAILED${typeof status === 'number' ? `_${status}` : ''}`);
}
