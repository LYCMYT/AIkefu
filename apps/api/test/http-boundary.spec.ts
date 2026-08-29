import { validateEnvironment } from '../src/common/environment';
import {
  BuyerMessageDto,
  CustomerMemoryDto,
  KnowledgeSearchDto,
  ShopSettingsDto,
  WorkflowGraphDto,
} from '../src/common/request-dtos';
import { createRequestValidationPipe } from '../src/common/request-validation.pipe';

describe('HTTP runtime boundaries', () => {
  const pipe = createRequestValidationPipe();

  it('rejects unknown fields and oversized buyer text before controller execution', async () => {
    await expect(pipe.transform({
      shopId: 'shop-a',
      buyerId: 'buyer-a',
      kind: 'TEXT',
      text: 'hello',
      injected: true,
    }, metadata(BuyerMessageDto))).rejects.toMatchObject({ status: 400 });

    await expect(pipe.transform({
      shopId: 'shop-a',
      buyerId: 'buyer-a',
      kind: 'TEXT',
      text: 'x'.repeat(4_001),
    }, metadata(BuyerMessageDto))).rejects.toMatchObject({ status: 400 });
  });

  it('enforces frozen knowledge topK and workflow graph limits', async () => {
    await expect(pipe.transform({ shopId: 'shop-a', query: '材质', topK: 4 }, metadata(KnowledgeSearchDto)))
      .rejects.toMatchObject({ status: 400 });

    const nodes = Array.from({ length: 21 }, (_, index) => ({
      id: `node-${index}`,
      type: index === 0 ? 'TRIGGER' : 'END',
      position: { x: index, y: index },
      config: {},
    }));
    await expect(pipe.transform({ nodes, edges: [], settings: { maxSteps: 20, timeoutMs: 30_000 } }, metadata(WorkflowGraphDto)))
      .rejects.toMatchObject({ status: 400 });
  });

  it('bounds arbitrary CustomerMemory JSON while preserving a valid payload', async () => {
    const valid = await pipe.transform({
      shopId: 'shop-a',
      type: 'PREFERENCE',
      key: 'preferred_material',
      value: { text: '316L' },
    }, metadata(CustomerMemoryDto));
    expect(valid).toMatchObject({ shopId: 'shop-a', key: 'preferred_material' });

    await expect(pipe.transform({
      shopId: 'shop-a',
      type: 'PREFERENCE',
      key: 'oversized',
      value: { text: 'x'.repeat(8_193) },
    }, metadata(CustomerMemoryDto))).rejects.toMatchObject({ status: 400 });
  });

  it('treats ShopSettings PUT as a full replacement and rejects malformed rule objects', async () => {
    const valid = {
      tone: '亲切', logisticsPolicy: '物流', shippingPolicy: '发货', afterSalesPolicy: '售后',
      welcomeMessage: '欢迎', closingMessages: { NO_ORDER: '再见' }, transferKeywords: ['人工'],
      forbiddenTerms: [{ term: '绝对', replacement: '尽量' }],
    };
    await expect(pipe.transform(valid, metadata(ShopSettingsDto))).resolves.toMatchObject(valid);
    const { welcomeMessage: _omitted, ...missing } = valid;
    await expect(pipe.transform(missing, metadata(ShopSettingsDto))).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({
      ...valid,
      forbiddenTerms: [{ term: '绝对', replacement: '尽量', injected: true }],
    }, metadata(ShopSettingsDto))).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed on malformed environment values and accepts the bounded offline demo configuration', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production', WEB_ORIGIN: '*' })).toThrow('ENVIRONMENT_INVALID');
    expect(() => validateEnvironment({ API_PORT: '0' })).toThrow('ENVIRONMENT_INVALID');
    expect(() => validateEnvironment({ AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'TRUE' })).toThrow('ENVIRONMENT_INVALID');
    expect(() => validateEnvironment({ AI_PROVIDER: 'unknown-provider' })).toThrow('ENVIRONMENT_INVALID');

    expect(validateEnvironment({
      NODE_ENV: 'test',
      API_PORT: '3000',
      WEB_ORIGIN: 'http://localhost:5173',
      AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'false',
      ATTACHMENT_STORAGE_TIMEOUT_MS: '8000',
    })).toMatchObject({ apiPort: 3000, webOrigin: 'http://localhost:5173' });
  });
});

function metadata(metatype: new () => object) {
  return { type: 'body' as const, metatype, data: undefined };
}
