import { MinioObjectStorage } from '../src/attachments/attachments.storage';
import type { S3Client } from '@aws-sdk/client-s3';

describe('MinioObjectStorage transport boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aborts a non-cooperative object-storage request at the configured deadline', async () => {
    const storage = new MinioObjectStorage({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'attachments',
      region: 'us-east-1',
      accessKeyId: 'demo-access',
      secretAccessKey: 'demo-secret',
      forcePathStyle: true,
      requestTimeoutMs: 10,
      client: { send: jest.fn(() => new Promise(() => undefined)) } as unknown as S3Client,
    });

    await expect(storage.deleteObject('opaque/object')).rejects.toThrow('ATTACHMENT_STORAGE_TIMEOUT');
  });
});
