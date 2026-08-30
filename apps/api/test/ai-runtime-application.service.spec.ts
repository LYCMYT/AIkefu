import { AiRuntime, AiRuntimeFailure, type AiProvider, type AiProviderRequest } from '@ai-customer-service/core';
import { AiRuntimeApplicationService } from '../src/ai/ai-runtime-application.service';

describe('AiRuntimeApplicationService', () => {
  it('sanitizes provider context and persists scoped usage with immutable evidence', async () => {
    const calls: AiProviderRequest[] = [];
    const provider: AiProvider = {
      name: 'test-provider',
      invoke: async (request) => {
        calls.push(request);
        return {
          output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
          model: 'test-model',
          usage: { inputTokens: 12, outputTokens: 4 },
        };
      },
    };
    const runtime = new AiRuntime({ providers: { provider }, routes: { RISK_CLASSIFIER: ['provider'] } });
    const invocation = { id: 'invocation-1' };
    const ledger = {
      start: jest.fn().mockResolvedValue(invocation),
      complete: jest.fn().mockResolvedValue(invocation),
      recordUsage: jest.fn().mockResolvedValue({ id: 'usage-1' }),
    };
    const gateway = { publish: jest.fn() };
    const service = new AiRuntimeApplicationService(runtime, ledger as never, gateway as never);
    const evidence = [{
      itemId: 'item-1', versionId: 'version-2', version: 2, source: 'MANUAL' as const,
      scope: 'PRODUCT' as const, productId: 'product-1',
      contentSnapshot: { question: '材质？', answer: '316L' }, retrievalScore: 0.93,
    }];

    const result = await service.runStructured(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' },
      {
        purpose: 'RISK_CLASSIFIER',
        schema: 'RiskResult',
        context: { text: '联系电话 13800138000', token: 'must-not-leave-server' },
        allowedDataClasses: ['text', 'token'],
        promptVersion: 'reply-risk-v1',
        evidence,
      },
    );

    expect(result.output.riskLevel).toBe('LOW');
    expect(JSON.stringify(calls[0]?.input)).toContain('[REDACTED_PHONE]');
    expect(JSON.stringify(calls[0]?.input)).not.toContain('13800138000');
    expect(JSON.stringify(calls[0]?.input)).not.toContain('must-not-leave-server');
    expect(ledger.start).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' }),
      expect.objectContaining({
        provider: 'unresolved',
        model: 'unresolved',
        includedDataClasses: ['text'],
        excludedPII: ['PHONE'],
        evidence: [expect.objectContaining({ versionId: 'version-2' })],
      }),
    );
    expect(ledger.complete).toHaveBeenCalledWith(expect.any(Object), 'invocation-1', expect.objectContaining({
      status: 'SUCCEEDED', provider: 'test-provider', model: 'test-model',
    }));
    expect(ledger.recordUsage).toHaveBeenCalledWith(expect.any(Object), 'invocation-1', expect.objectContaining({ success: true }));
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'USAGE_UPDATED',
      workspaceId: 'workspace-1',
      entityType: 'USAGE',
      entityId: 'invocation-1',
    }));

    evidence[0]!.contentSnapshot.answer = 'mutated later';
    expect(ledger.start.mock.calls[0]![1].evidence[0].contentSnapshot.answer).toBe('316L');
  });

  it('persists a RUNNING invocation before the provider is allowed to start', async () => {
    const order: string[] = [];
    const ledger = {
      start: jest.fn(async () => { order.push('STARTED'); return { id: 'invocation-running' }; }),
      complete: jest.fn(async () => { order.push('COMPLETED'); return { id: 'invocation-running' }; }),
      recordUsage: jest.fn().mockResolvedValue({ id: 'usage-running' }),
    };
    const runtime = {
      runStructured: jest.fn(async () => {
        order.push('PROVIDER');
        return {
          output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
          provider: 'primary', model: 'quality-v1', fallbackUsed: false,
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      }),
    };
    const service = new AiRuntimeApplicationService(runtime as never, ledger as never);

    await service.runStructured(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' },
      {
        purpose: 'RISK_CLASSIFIER', schema: 'RiskResult', context: { text: '你好' },
        allowedDataClasses: ['text'], promptVersion: 'reply-risk-v1',
      },
    );

    expect(order).toEqual(['STARTED', 'PROVIDER', 'COMPLETED']);
    expect(ledger.start).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      provider: 'unresolved', model: 'unresolved',
    }));
  });

  it('preserves a stable runtime failure while recording only non-sensitive failure metadata', async () => {
    const provider: AiProvider = {
      name: 'failing-provider',
      invoke: async () => { throw new Error('provider diagnostics must not be persisted'); },
    };
    const runtime = new AiRuntime({ providers: { provider }, routes: { SUMMARY: ['provider'] } });
    const ledger = {
      start: jest.fn().mockResolvedValue({ id: 'invocation-failed' }),
      complete: jest.fn().mockResolvedValue({ id: 'invocation-failed' }),
      recordUsage: jest.fn().mockResolvedValue({ id: 'usage-failed' }),
    };
    const service = new AiRuntimeApplicationService(runtime as never, ledger as never);

    await expect(service.runStructured(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' },
      {
        purpose: 'SUMMARY',
        schema: 'ConversationSummary',
        context: { messages: [{ text: 'secret content' }] },
        allowedDataClasses: ['messages'],
        promptVersion: 'conversation-summary-v1',
      },
    )).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });

    expect(ledger.complete).toHaveBeenCalledWith(expect.any(Object), 'invocation-failed', expect.objectContaining({ status: 'FAILED' }));
    expect(ledger.recordUsage).toHaveBeenCalledWith(expect.any(Object), 'invocation-failed', expect.objectContaining({
      success: false,
      errorCode: 'PROVIDER_FAILED',
    }));
    expect(JSON.stringify(ledger.start.mock.calls)).not.toContain('secret content');
    expect(JSON.stringify(ledger.recordUsage.mock.calls)).not.toContain('provider diagnostics');
  });

  it('keeps aborted invocation usage scoped when a later success reaches the shared runtime log first', async () => {
    const aResult = deferred<never>();
    const bUsage = {
      purpose: 'RISK_CLASSIFIER' as const,
      provider: 'succeeded-provider',
      model: 'succeeded-model',
      fallbackUsed: true,
      durationMs: 17,
      status: 'SUCCEEDED' as const,
      tokenUsage: { inputTokens: 41, outputTokens: 13 },
    };
    const aFailure = new AiRuntimeFailure('ABORTED', 'A became stale').withAudit({
        purpose: 'SUMMARY' as const,
        provider: 'aborted-provider',
        model: null,
        fallbackUsed: false,
        durationMs: 5,
        status: 'ABORTED' as const,
        tokenUsage: null,
    });
    const runtime = {
      runStructured: jest.fn((request: { purpose: string }) => {
        if (request.purpose === 'SUMMARY') return aResult.promise;
        return Promise.resolve({
          output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
          provider: 'succeeded-provider',
          model: 'succeeded-model',
          fallbackUsed: true,
          usage: bUsage.tokenUsage,
        });
      }),
      // This is intentionally the shared, unrelated B record. Before the
      // fix, A's catch consumed it via `usageLog().at(-1)`.
      usageLog: jest.fn(() => [bUsage]),
    };
    const starts: Array<{ id: string; input: Record<string, unknown> }> = [];
    const completions: Array<{ invocationId: string; input: Record<string, unknown> }> = [];
    const usages: Array<{ invocationId: string; input: Record<string, unknown> }> = [];
    const ledger = {
      start: jest.fn(async (_scope, input) => {
        const id = `invocation-${starts.length + 1}`;
        starts.push({ id, input });
        return { id };
      }),
      complete: jest.fn(async (_scope, invocationId, input) => {
        completions.push({ invocationId, input });
        return { id: invocationId };
      }),
      recordUsage: jest.fn(async (_scope, invocationId, input) => {
        usages.push({ invocationId, input });
        return { id: `usage-${invocationId}` };
      }),
    };
    const service = new AiRuntimeApplicationService(runtime as never, ledger as never);
    const scope = { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' };

    const aborted = service.runStructured(scope, {
      purpose: 'SUMMARY',
      schema: 'ConversationSummary',
      context: { messages: [{ text: 'A private prompt' }] },
      allowedDataClasses: ['messages'],
      promptVersion: 'conversation-summary-v1',
    });
    const succeeded = service.runStructured(scope, {
      purpose: 'RISK_CLASSIFIER',
      schema: 'RiskResult',
      context: { text: 'B safe' },
      allowedDataClasses: ['text'],
      promptVersion: 'reply-risk-v1',
    });
    await expect(succeeded).resolves.toMatchObject({ provider: 'succeeded-provider', model: 'succeeded-model' });
    // B has now completed while A remains pending. Release A only after the
    // shared runtime log points at B, giving the old global-last-log code a
    // deterministic cross-invocation value to misuse.
    aResult.reject(aFailure);
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' });

    const abortedStart = starts.find((entry) => entry.input.purpose === 'SUMMARY');
    expect(abortedStart?.input).toMatchObject({
      provider: 'unresolved',
      model: 'unresolved',
      fallbackUsed: false,
    });
    const abortedCompletion = completions.find((entry) => entry.invocationId === abortedStart?.id);
    expect(abortedCompletion?.input).toMatchObject({
      status: 'ABORTED',
      provider: 'aborted-provider',
      model: 'unresolved',
      inputTokens: 0,
      outputTokens: 0,
      fallbackUsed: false,
    });
    const abortedUsage = usages.find((entry) => entry.invocationId === abortedStart?.id);
    expect(abortedUsage?.input).toMatchObject({
      provider: 'aborted-provider',
      model: 'unresolved',
      inputTokens: 0,
      outputTokens: 0,
      success: false,
      fallbackUsed: false,
      errorCode: 'ABORTED',
    });
    expect(runtime.usageLog).not.toHaveBeenCalled();
    expect(JSON.stringify({ starts, completions, usages })).not.toContain('A private prompt');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
