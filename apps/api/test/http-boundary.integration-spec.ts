import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { BuyerSimulatorController } from '../src/messages/message.controllers';
import { MESSAGE_APPLICATION } from '../src/messages/message.application';
import { configureHttpApplication } from '../src/common/http-bootstrap';

describe('HTTP global security boundary', () => {
  let app: NestExpressApplication;
  const messages = {
    sendMessage: jest.fn(async () => ({ status: 'ACCEPTED', operationId: 'message-1' })),
    sendProductCard: jest.fn(),
    sendOrderCard: jest.fn(),
    editMessage: jest.fn(),
    recallMessage: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BuyerSimulatorController],
      providers: [{ provide: MESSAGE_APPLICATION, useValue: messages }],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(false);
    configureHttpApplication(app, {
      production: false,
      apiPort: 3000,
      webOrigin: 'http://localhost:5173',
      jsonBodyLimit: '1kb',
      attachmentStorageTimeoutMs: 8_000,
    });
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects unknown fields and returns security headers', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/buyer/messages')
      .send({ shopId: 'shop-a', buyerId: 'buyer-a', kind: 'TEXT', text: 'hello', injected: true })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(messages.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects JSON beyond the configured global body limit', async () => {
    await request(app.getHttpServer())
      .post('/api/buyer/messages')
      .send({ shopId: 'shop-a', buyerId: 'buyer-a', kind: 'TEXT', text: 'x'.repeat(2_000) })
      .expect(413);
  });
});
