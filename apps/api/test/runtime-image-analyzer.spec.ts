import { AiRuntimeApplicationService } from '../src/ai/ai-runtime-application.service';
import {
  createImageAnalyzer,
  RuntimeImageAnalyzer,
  SyntheticImageAnalyzer,
} from '../src/attachments/image-analysis';

describe('RuntimeImageAnalyzer', () => {
  const untrustedBytes = Buffer.from('untrusted image: 电话 13800138000; email alice@example.com');
  const input = {
    workspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    shopId: 'shop-1',
    conversationId: 'conversation-1',
    bytes: untrustedBytes,
    mimeType: 'image/png',
    size: untrustedBytes.byteLength,
  };

  it.each([
    ['unset', {}],
    ['false', { AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'false' }],
    ['uppercase true', { AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'TRUE' }],
    ['padded true', { AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: ' true ' }],
    ['numeric value', { AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: '1' }],
  ])('keeps untrusted image bytes local when the external opt-in is %s', async (_label, environment) => {
    const runtime = { runStructured: jest.fn() };
    const analyzer = createImageAnalyzer(runtime as never, environment as NodeJS.ProcessEnv);

    expect(analyzer).toBeInstanceOf(SyntheticImageAnalyzer);
    const result = await analyzer.analyze(input);

    expect(runtime.runStructured).not.toHaveBeenCalled();
    const rendered = JSON.stringify({ result, runtimeCalls: runtime.runStructured.mock.calls });
    expect(rendered).not.toContain(untrustedBytes.toString('base64'));
    expect(rendered).not.toContain('13800138000');
    expect(rendered).not.toContain('alice@example.com');
  });

  it('allows the runtime analyzer only for exact server opt-in while keeping source bytes out of audit records', async () => {
    const output = {
      scene: 'PRODUCT_DAMAGE' as const,
      observations: ['袖口破损'],
      confidence: 0.91,
      containsPII: false,
      recommendedIntent: 'AFTER_SALES_QUERY',
      requiresHuman: true,
    };
    const providerRuntime = {
      runStructured: jest.fn().mockResolvedValue({
        output,
        provider: 'configured-vision',
        model: 'vision-model',
        fallbackUsed: false,
        usage: { inputTokens: 12, outputTokens: 4 },
      }),
    };
    const ledger = {
      start: jest.fn().mockResolvedValue({ id: 'invocation-1' }),
      complete: jest.fn().mockResolvedValue({ id: 'invocation-1' }),
      recordUsage: jest.fn().mockResolvedValue({ id: 'usage-1' }),
    };
    const runtime = new AiRuntimeApplicationService(providerRuntime as never, ledger as never);
    const analyzer = createImageAnalyzer(runtime, {
      AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'true',
    } as NodeJS.ProcessEnv);

    expect(analyzer).toBeInstanceOf(RuntimeImageAnalyzer);
    await expect(analyzer.analyze(input)).resolves.toEqual(output);

    expect(providerRuntime.runStructured).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'IMAGE_ANALYSIS',
      input: {
        image: {
          mimeType: 'image/png',
          size: untrustedBytes.byteLength,
          base64: untrustedBytes.toString('base64'),
        },
      },
    }));
    expect(ledger.start).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        tenantId: 'tenant-1',
        shopId: 'shop-1',
        conversationId: 'conversation-1',
      },
      expect.objectContaining({
        purpose: 'IMAGE_ANALYSIS',
        includedDataClasses: ['image'],
        evidence: [],
      }),
    );
    const recorded = JSON.stringify({
      start: ledger.start.mock.calls,
      complete: ledger.complete.mock.calls,
      usage: ledger.recordUsage.mock.calls,
    });
    expect(recorded).not.toContain(untrustedBytes.toString('base64'));
    expect(recorded).not.toContain('13800138000');
    expect(recorded).not.toContain('alice@example.com');
  });

  it('routes bounded image context through the scoped AI runtime', async () => {
    const output = {
      scene: 'PRODUCT_DAMAGE' as const,
      observations: ['袖口破损'],
      confidence: 0.91,
      containsPII: false,
      recommendedIntent: 'AFTER_SALES_QUERY',
      requiresHuman: true,
    };
    const runtime = { runStructured: jest.fn().mockResolvedValue({ output }) };
    const analyzer = createImageAnalyzer(runtime as never, {
      AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN: 'true',
    } as NodeJS.ProcessEnv);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    expect(analyzer).toBeInstanceOf(RuntimeImageAnalyzer);
    await expect(analyzer.analyze({
      workspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      shopId: 'shop-1',
      conversationId: 'conversation-1',
      bytes,
      mimeType: 'image/png',
      size: bytes.byteLength,
    })).resolves.toEqual(output);

    expect(runtime.runStructured).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        tenantId: 'tenant-1',
        shopId: 'shop-1',
        conversationId: 'conversation-1',
      },
      expect.objectContaining({
        purpose: 'IMAGE_ANALYSIS',
        schema: 'ImageAnalysis',
        promptVersion: 'image-analysis-v1',
        allowedDataClasses: ['image'],
        context: {
          image: {
            mimeType: 'image/png',
            size: 4,
            base64: bytes.toString('base64'),
          },
        },
      }),
    );
  });
});
