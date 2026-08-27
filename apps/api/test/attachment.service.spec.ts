import { NotFoundException } from '@nestjs/common';
import {
  ATTACHMENT_RETENTION_MS,
  AttachmentService,
  MAX_ATTACHMENT_BYTES,
} from '../src/attachments/attachments.service';
import { InMemoryAttachmentRepository } from '../src/attachments/attachments.repository';
import { InMemoryObjectStorage } from '../src/attachments/attachments.storage';
import { SyntheticImageAnalyzer } from '../src/attachments/image-analysis';
import { sanitizeAttachmentContext } from '../src/attachments/context-sanitizer';
import type { AttachmentScope } from '../src/attachments/attachments.types';

describe('AttachmentService', () => {
  const scope: AttachmentScope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
  const shopScope: AttachmentScope = { ...scope, shopId: 'shop-a' };
  const now = new Date('2026-08-27T00:00:00.000Z');

  function setup() {
    const repository = new InMemoryAttachmentRepository({
      shops: [{ ...scope, id: 'shop-a' }],
      buyers: [{ ...scope, id: 'buyer-a' }],
      conversations: [{ ...scope, id: 'conversation-a', shopId: 'shop-a', buyerId: 'buyer-a' }],
    });
    const storage = new InMemoryObjectStorage({ now: () => now });
    const service = new AttachmentService(repository, storage, new SyntheticImageAnalyzer(), {
      now: () => now,
      signedUrlTtlSeconds: 60,
    });
    return { repository, storage, service };
  }

  it('isolates workspace, shop, buyer, and conversation ownership before storing bytes', async () => {
    const { service, storage } = setup();

    await expect(
      service.upload(
        scope,
        imageUpload({ shopId: 'shop-other', buyerId: 'buyer-a', conversationId: 'conversation-a' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'SHOP_NOT_FOUND' } });
    expect(storage.keys()).toEqual([]);

    await expect(
      service.upload(
        scope,
        imageUpload({ shopId: 'shop-a', buyerId: 'buyer-other', conversationId: 'conversation-a' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUYER_NOT_FOUND' } });
    expect(storage.keys()).toEqual([]);

    await expect(
      service.upload(
        { workspaceId: 'workspace-other', tenantId: 'tenant-a' },
        imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', conversationId: 'conversation-a' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'SHOP_NOT_FOUND' } });
    expect(storage.keys()).toEqual([]);

    const own = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', conversationId: 'conversation-a' }),
    );
    await expect(
      service.createSignedUrl({ workspaceId: 'workspace-other', tenantId: 'tenant-a', shopId: 'shop-a' }, own.id, now),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_NOT_FOUND' } });
  });

  it('accepts only bounded raster images and stores an opaque key', async () => {
    const { service, storage } = setup();
    const result = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', conversationId: 'conversation-a' }),
    );

    expect(result).toMatchObject({
      mimeType: 'image/png',
      size: PNG.length,
      status: 'ACTIVE',
      containsPII: false,
      expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION_MS).toISOString(),
    });
    expect(result.id).toBeTruthy();
    expect(result.analysis).toMatchObject({ scene: 'UNKNOWN', requiresHuman: true });
    const [key] = storage.keys();
    expect(key).toBeTruthy();
    expect(key).not.toContain('workspace-a');
    expect(key).not.toContain('shop-a');
    expect(key).not.toContain('buyer-a');
    expect(key).not.toContain('conversation-a');

    await expect(
      service.upload(
        scope,
        imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', mimeType: 'image/svg+xml' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_MIME_UNSAFE' } });
    await expect(
      service.upload(
        scope,
        imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_TOO_LARGE' } });
    await expect(
      service.upload(
        scope,
        imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', mimeType: 'image/png', buffer: JPEG }),
      ),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
  });

  it('persists a PENDING intent before bytes and returns only the CAS-activated attachment', async () => {
    const { service, repository, storage } = setup();
    const originalCreate = repository.create.bind(repository);
    const create = jest.spyOn(repository, 'create');
    const originalPut = storage.putObject.bind(storage);
    let intentCreated = false;
    create.mockImplementation(async (input) => {
      expect(input.status).toBe('PENDING');
      intentCreated = true;
      return originalCreate(input);
    });
    jest.spyOn(storage, 'putObject').mockImplementation(async (input) => {
      expect(intentCreated).toBe(true);
      return originalPut(input);
    });

    const attachment = await service.upload(scope, imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }));

    expect(attachment.status).toBe('ACTIVE');
    expect(repository.get(attachment.id)?.status).toBe('ACTIVE');
  });

  it('rejects forged raster signatures, corrupt PNG chunks, and oversized decoded dimensions', async () => {
    const { service } = setup();
    const corruptCrc = Buffer.from(PNG);
    corruptCrc[41] = (corruptCrc[41] ?? 0) ^ 0xff;

    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: pngWithoutIdat(), mimeType: 'image/png',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: corruptCrc, mimeType: 'image/png',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: pngWithInvalidCompressedData(), mimeType: 'image/png',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: pngWithDimensions(100_000, 100_000), mimeType: 'image/png',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: JPEG, mimeType: 'image/jpeg',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
    await expect(service.upload(scope, imageUpload({
      shopId: 'shop-a', buyerId: 'buyer-a', buffer: FORGED_WEBP, mimeType: 'image/webp',
    }))).rejects.toMatchObject({ response: { code: 'ATTACHMENT_CONTENT_MISMATCH' } });
  });

  it('uses only deterministic synthetic fixture markers for multimodal scenes', async () => {
    const { service } = setup();
    const damaged = await service.upload(
      scope,
      imageUpload({
        shopId: 'shop-a',
        buyerId: 'buyer-a',
        buffer: fixturePng('AICS_FIXTURE:DAMAGED_SLEEVE'),
      }),
    );
    expect(damaged.analysis).toMatchObject({
      scene: 'PRODUCT_DAMAGE',
      recommendedIntent: 'AFTER_SALES_QUERY',
      requiresHuman: true,
    });
    expect(damaged.analysis?.observations).toContain('疑似商品破损');

    const label = await service.upload(
      scope,
      imageUpload({
        shopId: 'shop-a',
        buyerId: 'buyer-a',
        buffer: fixturePng('AICS_FIXTURE:SHIPPING_LABEL'),
      }),
    );
    expect(label).toMatchObject({ containsPII: true });
    expect(label.analysis).toMatchObject({
      scene: 'SHIPPING_LABEL',
      recommendedIntent: 'ORDER_QUERY',
      requiresHuman: true,
      containsPII: true,
    });
    expect(label.analysis?.observations.join(' ')).not.toMatch(/1[3-9]\d{9}|完整地址|手机号/);
  });

  it('returns a short-lived signed URL and never extends attachment retention', async () => {
    const { service, repository, storage } = setup();
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );

    const signed = await service.createSignedUrl(shopScope, attachment.id, now);
    expect(signed.expiresAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(signed.url).toContain('signed');
    expect(signed.url).not.toContain('workspace-a');
    expect(storage.resolve(signed.url)).toEqual(PNG);
    expect(repository.get(attachment.id)?.expiresAt).toEqual(
      new Date(now.getTime() + ATTACHMENT_RETENTION_MS),
    );
  });

  it('sanitizes image context and never promotes an image into knowledge', async () => {
    const { service, repository } = setup();
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', buffer: fixturePng('AICS_FIXTURE:SHIPPING_LABEL') }),
    );
    const record = repository.get(attachment.id)!;
    const replyContext = sanitizeAttachmentContext([record], 'generateReply');
    expect(replyContext.attachments[0]).toMatchObject({
      id: attachment.id,
      analysis: { scene: 'SHIPPING_LABEL', containsPII: true, observations: [], recommendedIntent: 'ORDER_QUERY' },
    });
    expect(JSON.stringify(replyContext)).not.toContain(record.objectKey);
    expect(sanitizeAttachmentContext([record], 'knowledgeExtract').attachments).toEqual([]);
  });

  it('redacts PII found in untrusted image observations before persistence and response', async () => {
    const repository = new InMemoryAttachmentRepository({
      shops: [{ ...scope, id: 'shop-a' }],
      buyers: [{ ...scope, id: 'buyer-a' }],
      conversations: [{ ...scope, id: 'conversation-a', shopId: 'shop-a', buyerId: 'buyer-a' }],
    });
    const storage = new InMemoryObjectStorage({ now: () => now });
    const analyzer = {
      analyze: jest.fn().mockResolvedValue({
        scene: 'SHIPPING_LABEL',
        observations: ['电话 13800138000，邮箱 alice@example.com'],
        confidence: 0.99,
        containsPII: false,
        recommendedIntent: 'ORDER_QUERY 电话 13800138000，邮箱 alice@example.com',
        requiresHuman: false,
      }),
    };
    const service = new AttachmentService(repository, storage, analyzer, { now: () => now });

    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );

    expect(attachment.containsPII).toBe(true);
    expect(attachment.analysis?.requiresHuman).toBe(true);
    expect(attachment.analysis?.observations).toEqual([]);
    expect(attachment.analysis?.recommendedIntent).toBeUndefined();
    expect(JSON.stringify(attachment)).not.toContain('13800138000');
    expect(JSON.stringify(attachment)).not.toContain('alice@example.com');
    expect(repository.get(attachment.id)?.analysisJson?.observations).toEqual([]);
    expect(repository.get(attachment.id)?.analysisJson?.recommendedIntent).toBeUndefined();

    const replyContext = sanitizeAttachmentContext([repository.get(attachment.id)!], 'generateReply');
    expect(replyContext.attachments[0]?.analysis?.recommendedIntent).toBeUndefined();
    expect(JSON.stringify(replyContext)).not.toContain('13800138000');
    expect(JSON.stringify(replyContext)).not.toContain('alice@example.com');
  });

  it('does not forward an arbitrary legacy image intent into AI context', async () => {
    const { service, repository } = setup();
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );
    const record = repository.get(attachment.id)!;
    const poisonedLegacyRecord = {
      ...record,
      analysisJson: {
        ...record.analysisJson!,
        recommendedIntent: 'CALL_ME_13800138000_alice@example.com',
      },
    };

    const replyContext = sanitizeAttachmentContext([poisonedLegacyRecord], 'generateReply');

    expect(replyContext.attachments[0]?.analysis?.recommendedIntent).toBeUndefined();
    expect(JSON.stringify(replyContext)).not.toContain('13800138000');
    expect(JSON.stringify(replyContext)).not.toContain('alice@example.com');
  });

  it('denies expired objects and cleanup removes bytes while preserving an expired tombstone', async () => {
    const { service, repository, storage } = setup();
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );
    const expiredAt = new Date(now.getTime() + ATTACHMENT_RETENTION_MS + 1);

    await expect(service.createSignedUrl(shopScope, attachment.id, expiredAt)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.get(attachment.id)?.status).toBe('EXPIRED');
    expect(storage.keys()).toEqual([]);

    const second = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );
    const cleaned = await service.cleanupExpired(expiredAt);
    expect(cleaned).toBe(1);
    expect(repository.get(second.id)?.status).toBe('EXPIRED');
    expect(storage.keys()).toEqual([]);
  });

  it('keeps expired metadata ACTIVE when object deletion fails so the next sweep can retry', async () => {
    const { service, repository, storage } = setup();
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }),
    );
    jest.spyOn(storage, 'deleteObject').mockRejectedValueOnce(new Error('transient object storage outage'));

    const cleaned = await service.cleanupExpired(new Date(now.getTime() + ATTACHMENT_RETENTION_MS + 1));

    expect(cleaned).toBe(0);
    expect(repository.get(attachment.id)?.status).toBe('ACTIVE');
    expect(storage.keys()).toHaveLength(1);
  });

  it('expires a crash-left PENDING intent that already has an object at retention', async () => {
    const { service, repository, storage } = setup();
    const pending = await repository.create({
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      buyerId: 'buyer-a',
      conversationId: null,
      objectKey: 'attachments/pending-with-object',
      mimeType: 'image/png',
      size: PNG.byteLength,
      status: 'PENDING',
      containsPII: true,
      analysisJson: null,
      expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION_MS),
      createdAt: now,
    } as never);
    await storage.putObject({ key: pending.objectKey, body: PNG, contentType: 'image/png' });

    await expect(service.cleanupExpired(new Date(now.getTime() + ATTACHMENT_RETENTION_MS + 1))).resolves.toBe(1);
    expect(repository.get(pending.id)?.status).toBe('EXPIRED');
    expect(storage.has(pending.objectKey)).toBe(false);
  });

  it('expires a crash-left PENDING intent even when its object was never written', async () => {
    const { service, repository, storage } = setup();
    const pending = await repository.create({
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      buyerId: 'buyer-a',
      conversationId: null,
      objectKey: 'attachments/pending-without-object',
      mimeType: 'image/png',
      size: PNG.byteLength,
      status: 'PENDING',
      containsPII: true,
      analysisJson: null,
      expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION_MS),
      createdAt: now,
    } as never);
    jest.spyOn(storage, 'deleteObject').mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }));

    await expect(service.cleanupExpired(new Date(now.getTime() + ATTACHMENT_RETENTION_MS + 1))).resolves.toBe(1);
    expect(repository.get(pending.id)?.status).toBe('EXPIRED');
  });

  it('never serves a PENDING intent through get or a signed URL', async () => {
    const { service, repository, storage } = setup();
    const pending = await repository.create({
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      buyerId: 'buyer-a',
      conversationId: null,
      objectKey: 'attachments/pending-not-readable',
      mimeType: 'image/png',
      size: PNG.byteLength,
      status: 'PENDING',
      containsPII: true,
      analysisJson: null,
      expiresAt: new Date(now.getTime() + ATTACHMENT_RETENTION_MS),
      createdAt: now,
    } as never);
    await storage.putObject({ key: pending.objectKey, body: PNG, contentType: 'image/png' });
    const signer = jest.spyOn(storage, 'createSignedReadUrl');

    await expect(service.get(shopScope, pending.id)).rejects.toMatchObject({ response: { code: 'ATTACHMENT_EXPIRED' } });
    await expect(service.createSignedUrl(shopScope, pending.id, now)).rejects.toMatchObject({ response: { code: 'ATTACHMENT_EXPIRED' } });
    expect(signer).not.toHaveBeenCalled();
    expect(storage.has(pending.objectKey)).toBe(true);
  });

  it('keeps a PENDING intent as the durable owner when activation fails and object deletion cannot be confirmed', async () => {
    const { service, repository, storage } = setup();
    const markActive = jest.fn().mockResolvedValue(null);
    Object.assign(repository, { markActive });
    const originalCreate = repository.create.bind(repository);
    let intentId = '';
    jest.spyOn(repository, 'create').mockImplementation(async (input) => {
      const created = await originalCreate(input);
      intentId = created.id;
      return created;
    });
    jest.spyOn(storage, 'deleteObject').mockRejectedValueOnce(new Error('transient storage outage'));

    await expect(service.upload(scope, imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }))).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_CREATE_FAILED' },
    });

    expect(markActive).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a' },
      intentId,
      now,
    );
    const pending = repository.get(intentId);
    expect(pending).toMatchObject({ status: 'PENDING' });
    expect(storage.keys()).toEqual([pending?.objectKey]);
  });

  it('retires a durable PENDING intent after an ordinary object-write failure when deletion is confirmed', async () => {
    const { service, repository, storage } = setup();
    const originalCreate = repository.create.bind(repository);
    let intentId = '';
    jest.spyOn(repository, 'create').mockImplementation(async (input) => {
      const created = await originalCreate(input);
      intentId = created.id;
      return created;
    });
    jest.spyOn(storage, 'putObject').mockRejectedValueOnce(new Error('transient object write failure'));

    await expect(service.upload(scope, imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a' }))).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_CREATE_FAILED' },
    });
    expect(repository.get(intentId)).toMatchObject({ status: 'EXPIRED' });
    expect(storage.keys()).toEqual([]);
  });

  it('does not log binary contents, original names, signed URLs, or workspace tokens', async () => {
    const { repository, storage } = setup();
    const entries: unknown[] = [];
    const service = new AttachmentService(repository, storage, new SyntheticImageAnalyzer(), {
      now: () => now,
      logger: { log: (entry: unknown) => entries.push(entry) },
    });
    const attachment = await service.upload(
      scope,
      imageUpload({ shopId: 'shop-a', buyerId: 'buyer-a', originalname: 'private-token-123.png' }),
    );
    await service.createSignedUrl(shopScope, attachment.id, now);
    const rendered = JSON.stringify(entries);
    expect(rendered).not.toContain('private-token-123');
    expect(rendered).not.toContain('in-memory.invalid');
    expect(rendered).not.toContain('token-a');
    expect(rendered).not.toContain(PNG.toString('base64'));
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ includedDataClasses: expect.any(Array), excludedPII: expect.any(Array) }),
      ]),
    );
  });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function fixturePng(marker: string): Buffer {
  return Buffer.concat([PNG, Buffer.from(marker, 'utf8')]);
}

const FORGED_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);

function pngWithoutIdat(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngWithDimensions(width: number, height: number): Buffer {
  const result = Buffer.from(PNG);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29);
  return result;
}

function pngWithInvalidCompressedData(): Buffer {
  return Buffer.concat([
    PNG.subarray(0, 8),
    pngChunk('IHDR', PNG.subarray(16, 29)),
    pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function imageUpload(overrides: Partial<{
  shopId: string;
  buyerId: string;
  conversationId: string;
  mimeType: string;
  buffer: Buffer;
  originalname: string;
}> = {}) {
  return {
    shopId: overrides.shopId ?? 'shop-a',
    buyerId: overrides.buyerId ?? 'buyer-a',
    conversationId: overrides.conversationId ?? 'conversation-a',
    file: {
      buffer: overrides.buffer ?? PNG,
      mimetype: overrides.mimeType ?? 'image/png',
      originalname: overrides.originalname ?? 'photo.png',
    },
  };
}
