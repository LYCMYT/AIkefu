import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sanitizeContext } from '@ai-customer-service/core';
import { ATTACHMENT_REPOSITORY } from './attachments.repository';
import {
  IMAGE_ANALYZER,
  SyntheticImageAnalyzer,
  sanitizeImageRecommendedIntent,
  type ImageAnalysis,
  type ImageAnalyzer,
} from './image-analysis';
import { OBJECT_STORAGE, type ObjectStorage } from './attachments.storage';
import type {
  AttachmentCreateInput,
  AttachmentRecord,
  AttachmentRepository,
  AttachmentScope,
  AttachmentView,
  SignedAttachmentUrl,
  UploadAttachmentInput,
} from './attachments.types';
import { isSafeRasterImage } from './image-format';

export const ATTACHMENT_OPTIONS = Symbol('ATTACHMENT_OPTIONS');
export const ATTACHMENT_RETENTION_DAYS = 15;
export const ATTACHMENT_RETENTION_MS = ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 300;

const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_SCENES = new Set([
  'PRODUCT_DAMAGE',
  'PRODUCT_APPEARANCE',
  'SHIPPING_LABEL',
  'ORDER_SCREENSHOT',
  'UNRELATED',
  'UNKNOWN',
]);

export type AttachmentLogger = {
  log(entry: Record<string, unknown>): void;
};

export type AttachmentServiceOptions = {
  maxBytes?: number;
  retentionDays?: number;
  signedUrlTtlSeconds?: number;
  now?: () => Date;
  logger?: AttachmentLogger;
};

/**
 * Attachment application boundary.  It owns validation, scope checks,
 * retention, and the hand-off between metadata and object storage; callers
 * never provide a storage key or a provider credential.
 */
@Injectable()
export class AttachmentService {
  private readonly analyzer: ImageAnalyzer;
  private readonly options: Required<Pick<AttachmentServiceOptions, 'maxBytes' | 'retentionDays' | 'signedUrlTtlSeconds'>> &
    Pick<AttachmentServiceOptions, 'now'>;
  private readonly logger: AttachmentLogger;

  constructor(
    @Inject(ATTACHMENT_REPOSITORY) private readonly repository: AttachmentRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Optional() @Inject(IMAGE_ANALYZER) analyzerOrOptions?: ImageAnalyzer | AttachmentServiceOptions,
    @Optional() @Inject(ATTACHMENT_OPTIONS) configuredOptions?: AttachmentServiceOptions,
  ) {
    const inlineOptions = isImageAnalyzer(analyzerOrOptions) ? undefined : analyzerOrOptions;
    const options = { ...readEnvironmentOptions(), ...inlineOptions, ...configuredOptions };
    this.analyzer = isImageAnalyzer(analyzerOrOptions) ? analyzerOrOptions : new SyntheticImageAnalyzer();
    this.options = {
      maxBytes: positiveInteger(options.maxBytes, MAX_ATTACHMENT_BYTES),
      retentionDays: positiveNumber(options.retentionDays, ATTACHMENT_RETENTION_DAYS),
      signedUrlTtlSeconds: Math.min(
        300,
        positiveInteger(options.signedUrlTtlSeconds, SIGNED_URL_TTL_SECONDS),
      ),
      now: options.now,
    };
    this.logger = options.logger ?? new NestAttachmentLogger();
  }

  async upload(scope: AttachmentScope, input: UploadAttachmentInput, now = this.currentTime()): Promise<AttachmentView> {
    validateScope(scope);
    if (!input?.shopId || !input.buyerId) {
      throw bad('ATTACHMENT_OWNERSHIP_REQUIRED', 'shopId and buyerId are required');
    }
    if (!input.file) throw bad('ATTACHMENT_FILE_REQUIRED', 'file is required');
    if (scope.shopId && scope.shopId !== input.shopId) throw missing('SHOP_NOT_FOUND', 'shop not found');
    if (scope.buyerId && scope.buyerId !== input.buyerId) throw missing('BUYER_NOT_FOUND', 'buyer not found');
    await this.repository.assertOwnership?.(scope, {
      shopId: input.shopId,
      buyerId: input.buyerId,
      conversationId: input.conversationId,
    });

    const { buffer, mimeType } = validateImage(input.file, this.options.maxBytes);
    let analysis: ImageAnalysis;
    try {
      analysis = normalizeAnalysis(await this.analyzer.analyze({
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: input.shopId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        bytes: buffer,
        mimeType,
        size: buffer.byteLength,
      }));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Analyzer failures must not surface provider diagnostics or image
      // content through Nest's exception logger.
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_ANALYSIS_FAILED',
        message: 'could not analyze image',
      });
    }
    const objectKey = opaqueObjectKey();
    const expiresAt = new Date(now.getTime() + this.options.retentionDays * 24 * 60 * 60 * 1000);
    const intentScope: AttachmentScope = {
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: input.shopId,
      buyerId: input.buyerId,
    };
    let intent: AttachmentRecord;
    try {
      // The database intent deliberately precedes object storage. A process
      // kill in either direction is therefore represented by a PENDING row
      // that lifecycle cleanup can find, rather than an untracked PII object.
      intent = await this.repository.create({
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: input.shopId,
        buyerId: input.buyerId,
        conversationId: input.conversationId ?? null,
        objectKey,
        mimeType,
        size: buffer.byteLength,
        status: 'PENDING',
        containsPII: Boolean(analysis.containsPII),
        analysisJson: analysis,
        expiresAt,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_CREATE_FAILED',
        message: 'could not store attachment',
      });
    }
    try {
      await this.storage.putObject({ key: objectKey, body: buffer, contentType: mimeType });
      const activated = await this.repository.markActive(intentScope, intent.id, now);
      // A caller can lose the CAS response after the database already marked
      // the intent ACTIVE. Re-read within the full scope before treating that
      // ambiguous outcome as a failed upload and deleting a live object.
      const active = activated?.status === 'ACTIVE'
        ? activated
        : await this.repository.findById(intentScope, intent.id);
      if (!active || active.status !== 'ACTIVE') throw new Error('ATTACHMENT_INTENT_ACTIVATION_FAILED');
      this.safeLog({
        event: 'attachment.created',
        attachmentId: active.id,
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: input.shopId,
        buyerId: input.buyerId,
        mimeType,
        size: buffer.byteLength,
        includedDataClasses: ['attachment.metadata', 'image.analysis'],
        excludedPII: ['raw_binary', 'original_filename', 'workspace_token', 'signed_url'],
      });
      return toView(active);
    } catch (error) {
      await this.discardPendingIntent(intent, intentScope, now);
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      // Do not rethrow storage/Prisma diagnostics: they can contain the opaque
      // object key or request metadata. The durable intent remains available
      // to lifecycle cleanup whenever deletion could not be confirmed.
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_CREATE_FAILED',
        message: 'could not store attachment',
      });
    }
  }

  async createAttachment(scope: AttachmentScope, input: UploadAttachmentInput, now = this.currentTime()): Promise<AttachmentView> {
    return this.upload(scope, input, now);
  }

  async createSignedUrl(scope: AttachmentScope, attachmentId: string, now = this.currentTime()): Promise<SignedAttachmentUrl> {
    validateAttachmentAccessScope(scope);
    const record = await this.repository.findById(scope, attachmentId);
    if (!record) throw missing('ATTACHMENT_NOT_FOUND', 'attachment not found');
    const remainingMs = record.expiresAt.getTime() - now.getTime();
    if (record.status !== 'ACTIVE' || remainingMs <= 0) {
      await this.expireIfNeeded(record, scope, now);
      throw missing('ATTACHMENT_EXPIRED', 'attachment expired');
    }
    const ttl = Math.min(this.options.signedUrlTtlSeconds, Math.floor(remainingMs / 1000));
    if (ttl <= 0) {
      await this.expireIfNeeded(record, scope, now);
      throw missing('ATTACHMENT_EXPIRED', 'attachment expired');
    }
    let url: string;
    try {
      url = await this.storage.createSignedReadUrl(record.objectKey, ttl);
    } catch {
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_SIGNED_URL_FAILED',
        message: 'could not create attachment URL',
      });
    }
    const signedExpiresAt = new Date(now.getTime() + ttl * 1000);
    this.safeLog({
      event: 'attachment.signed_url_created',
      attachmentId: record.id,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      expiresAt: signedExpiresAt.toISOString(),
      includedDataClasses: ['attachment.metadata'],
      excludedPII: ['raw_binary', 'workspace_token', 'signed_url', 'object_key'],
    });
    return { url, expiresAt: signedExpiresAt.toISOString() };
  }

  async getSignedUrl(scope: AttachmentScope, attachmentId: string, now = this.currentTime()): Promise<SignedAttachmentUrl> {
    return this.createSignedUrl(scope, attachmentId, now);
  }

  async signedUrl(scope: AttachmentScope, attachmentId: string, now = this.currentTime()): Promise<SignedAttachmentUrl> {
    return this.createSignedUrl(scope, attachmentId, now);
  }

  async cleanupExpired(now = this.currentTime()): Promise<number> {
    const records = await this.repository.listExpired(now);
    let cleaned = 0;
    for (const record of records) {
      const recordScope: AttachmentScope = {
        workspaceId: record.workspaceId,
        tenantId: record.tenantId,
        shopId: record.shopId,
        buyerId: record.buyerId,
      };
      try {
        if (!(await this.removeObjectForLifecycle(record.objectKey))) continue;
        const expired = await this.repository.markExpired(recordScope, record.id, now);
        if (!expired) continue;
        cleaned += 1;
      } catch {
        // Keep the PENDING/ACTIVE intent when a provider operation fails so a
        // later lifecycle pass can retry it. No provider error is logged.
      }
    }
    if (cleaned > 0) {
      this.safeLog({
        event: 'attachment.expired_cleanup',
        count: cleaned,
        includedDataClasses: ['attachment.metadata'],
        excludedPII: ['raw_binary', 'workspace_token', 'signed_url', 'object_key'],
      });
    }
    return cleaned;
  }

  async sweepExpired(now = this.currentTime()): Promise<number> {
    return this.cleanupExpired(now);
  }

  async delete(scope: AttachmentScope, attachmentId: string, now = this.currentTime()): Promise<AttachmentView> {
    validateAttachmentAccessScope(scope);
    const record = await this.repository.findById(scope, attachmentId);
    if (!record) throw missing('ATTACHMENT_NOT_FOUND', 'attachment not found');
    if (!(await this.removeObjectForLifecycle(record.objectKey))) {
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_DELETE_FAILED',
        message: 'could not delete attachment',
      });
    }
    const deleted = await this.repository.markDeleted?.(scope, attachmentId, now);
    this.safeLog({
      event: 'attachment.deleted',
      attachmentId,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      includedDataClasses: ['attachment.metadata'],
      excludedPII: ['raw_binary', 'workspace_token', 'signed_url', 'object_key'],
    });
    return toView(deleted ?? { ...record, status: 'DELETED', deletedAt: now });
  }

  /**
   * Internal privacy erasure path. Unlike the user-facing delete endpoint it
   * scopes by the authenticated workspace/tenant plus buyer, so it can remove
   * every attachment for a customer across shops without trusting a caller to
   * nominate an individual shop id.
   */
  async deleteForCustomerData(
    scope: AttachmentScope & { buyerId: string },
    attachmentId: string,
    now = this.currentTime(),
  ): Promise<boolean> {
    validateScope(scope);
    if (!scope.buyerId?.trim()) throw bad('BUYER_ID_REQUIRED', 'buyerId is required');
    const record = await this.repository.findById(scope, attachmentId);
    // A prior retry may have already deleted the metadata. Treat that as a
    // completed idempotent operation; it must not block the whole erasure.
    if (!record) return false;
    if (record.status === 'DELETED' || record.status === 'EXPIRED') return true;
    if (!(await this.removeObjectForLifecycle(record.objectKey))) {
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_DELETE_FAILED',
        message: 'could not delete attachment',
      });
    }
    if (!this.repository.markDeleted) {
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_DELETE_METADATA_FAILED',
        message: 'could not confirm attachment deletion',
      });
    }
    const deleted = await this.repository.markDeleted(scope, attachmentId, now);
    if (!deleted) {
      // Storage deletion is intentionally not reported as a completed privacy
      // command until its durable database tombstone has also been committed.
      // A retry sees a missing object as idempotent and retries this CAS.
      throw new InternalServerErrorException({
        code: 'ATTACHMENT_DELETE_METADATA_FAILED',
        message: 'could not confirm attachment deletion',
      });
    }
    this.safeLog({
      event: 'attachment.customer_data_deleted',
      attachmentId,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      includedDataClasses: ['attachment.metadata'],
      excludedPII: ['raw_binary', 'workspace_token', 'signed_url', 'object_key'],
    });
    return true;
  }

  async remove(scope: AttachmentScope, attachmentId: string, now = this.currentTime()): Promise<AttachmentView> {
    return this.delete(scope, attachmentId, now);
  }

  async get(scope: AttachmentScope, attachmentId: string): Promise<AttachmentView> {
    validateAttachmentAccessScope(scope);
    const record = await this.repository.findById(scope, attachmentId);
    if (!record) throw missing('ATTACHMENT_NOT_FOUND', 'attachment not found');
    const now = this.currentTime();
    if (record.status !== 'ACTIVE' || record.expiresAt.getTime() <= now.getTime()) {
      await this.expireIfNeeded(record, scope, now);
      throw missing('ATTACHMENT_EXPIRED', 'attachment expired');
    }
    return toView(record);
  }

  private async expireIfNeeded(record: AttachmentRecord, scope: AttachmentScope, now: Date): Promise<void> {
    if ((record.status === 'PENDING' || record.status === 'ACTIVE') && record.expiresAt.getTime() <= now.getTime()) {
      if (await this.removeObjectForLifecycle(record.objectKey)) {
        await this.repository.markExpired(scope, record.id, now);
      }
    }
  }

  /**
   * A failed upload is safe only when its durable PENDING intent remains
   * discoverable. Delete bytes best-effort; advance the row only after that
   * deletion is confirmed so a later sweep can retry any ambiguous failure.
   */
  private async discardPendingIntent(record: AttachmentRecord, scope: AttachmentScope, now: Date): Promise<void> {
    try {
      const current = await this.repository.findById(scope, record.id);
      // Never delete an object that a concurrent/ambiguous activation already
      // made live. A missing row is likewise no longer this intent to retire.
      if (!current || current.status !== 'PENDING') return;
      record = current;
    } catch {
      // If the read itself is unavailable, use the durable PENDING record we
      // just created and still make the best-effort PII deletion attempt.
    }
    if (!(await this.removeObjectForLifecycle(record.objectKey))) return;
    try {
      await this.repository.markExpired(scope, record.id, now);
    } catch {
      // The PENDING row is still durable and will be retried by lifecycle.
    }
  }

  /**
   * Lifecycle metadata may advance only after storage confirms deletion. A
   * failure is intentionally reduced to a boolean so provider diagnostics and
   * opaque keys cannot escape into HTTP responses or logs.
   */
  private async removeObjectForLifecycle(objectKey: string): Promise<boolean> {
    try {
      await this.storage.deleteObject(objectKey);
      return true;
    } catch (error) {
      // S3/MinIO DELETE is normally idempotent; support adapters that expose
      // an explicit missing-object error so a crash before putObject can still
      // retire its PENDING intent.
      return isMissingObjectError(error);
    }
  }

  private currentTime(): Date {
    return new Date(this.options.now?.() ?? new Date());
  }

  private safeLog(entry: Record<string, unknown>): void {
    try {
      this.logger.log(entry);
    } catch {
      // Logging is observability only and cannot break attachment handling.
    }
  }
}

class NestAttachmentLogger implements AttachmentLogger {
  private readonly logger = new Logger(AttachmentService.name);

  log(entry: Record<string, unknown>): void {
    this.logger.log(entry);
  }
}

function validateScope(scope: AttachmentScope): void {
  if (!scope?.workspaceId || !scope.tenantId) throw bad('WORKSPACE_SCOPE_REQUIRED', 'workspace scope is required');
}

function validateAttachmentAccessScope(scope: AttachmentScope): void {
  validateScope(scope);
  if (!scope.shopId?.trim()) throw bad('SHOP_ID_REQUIRED', 'shopId is required');
}

function validateImage(file: UploadAttachmentInput['file'], maxBytes: number): { buffer: Buffer; mimeType: string } {
  if (!Buffer.isBuffer(file.buffer)) throw bad('ATTACHMENT_FILE_INVALID', 'file bytes are invalid');
  const size = file.buffer.byteLength;
  if (size <= 0) throw bad('ATTACHMENT_FILE_EMPTY', 'image cannot be empty');
  if (size > maxBytes) throw bad('ATTACHMENT_TOO_LARGE', 'image exceeds the maximum size');
  const mimeType = String(file.mimetype ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (!SAFE_IMAGE_MIME_TYPES.has(mimeType)) throw bad('ATTACHMENT_MIME_UNSAFE', 'only safe raster images are accepted');
  if (!isSafeRasterImage(file.buffer, mimeType)) {
    throw bad('ATTACHMENT_CONTENT_MISMATCH', 'image bytes do not match the declared MIME type');
  }
  return { buffer: Buffer.from(file.buffer), mimeType };
}

function normalizeAnalysis(value: ImageAnalysis): ImageAnalysis {
  if (!value || typeof value !== 'object' || !IMAGE_SCENES.has(value.scene)) {
    throw bad('ATTACHMENT_ANALYSIS_INVALID', 'image analysis is invalid');
  }
  if (!Array.isArray(value.observations) || value.observations.length > 12 || value.observations.some((item) => typeof item !== 'string')) {
    throw bad('ATTACHMENT_ANALYSIS_INVALID', 'image analysis is invalid');
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || typeof value.requiresHuman !== 'boolean') {
    throw bad('ATTACHMENT_ANALYSIS_INVALID', 'image analysis is invalid');
  }
  const rawObservations = value.observations.slice(0, 12).map((item) => item.slice(0, 500));
  const sanitized = sanitizeContext({ observations: rawObservations }, ['observations']);
  const piiDetected = sanitized.audit.excludedPII.length > 0;
  const containsPII = value.containsPII === true || piiDetected;
  const safeObservations = containsPII
    ? []
    : Array.isArray(sanitized.value.observations)
      ? sanitized.value.observations.filter((item): item is string => typeof item === 'string')
      : [];
  const recommendedIntent = sanitizeImageRecommendedIntent(value.recommendedIntent);
  return {
    scene: value.scene,
    observations: safeObservations,
    confidence,
    containsPII,
    ...(recommendedIntent ? { recommendedIntent } : {}),
    requiresHuman: value.requiresHuman || containsPII,
  };
}

function opaqueObjectKey(): string {
  return `attachments/${randomBytes(32).toString('hex')}`;
}

function toView(record: AttachmentRecord): AttachmentView {
  return {
    id: record.id,
    shopId: record.shopId,
    buyerId: record.buyerId,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    mimeType: record.mimeType,
    size: record.size,
    status: record.status,
    containsPII: record.containsPII,
    expiresAt: record.expiresAt.toISOString(),
    ...(record.analysisJson ? { analysis: record.analysisJson } : {}),
  };
}

function isImageAnalyzer(value: ImageAnalyzer | AttachmentServiceOptions | undefined): value is ImageAnalyzer {
  return Boolean(value && typeof (value as ImageAnalyzer).analyze === 'function');
}

function readEnvironmentOptions(): AttachmentServiceOptions {
  return {
    maxBytes: parseNumber(process.env.ATTACHMENT_MAX_BYTES),
    retentionDays: parseNumber(process.env.ATTACHMENT_RETENTION_DAYS),
    signedUrlTtlSeconds: parseNumber(process.env.SIGNED_URL_TTL_SECONDS),
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) && value > 0 ? value : fallback;
}

function bad(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

function missing(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (candidate.status === 404 || candidate.statusCode === 404) return true;
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if (code === 'NOSUCHKEY' || code === 'NOT_FOUND' || code === 'ATTACHMENT_OBJECT_NOT_FOUND') return true;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return /(?:no\s*such\s*key|object\s*not\s*found|key\s*not\s*found|attachment_storage_delete_failed_404)/.test(message);
}
