import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyImportRows,
  commitKnowledgeImport,
  createShop,
  createCustomerMemory,
  extractCollection,
  getKnowledgeCandidates,
  getKnowledgeConflicts,
  getProductLearningJobs,
  getBuyers,
  getCustomerMemories,
  getConversation,
  regenerateReply,
  resumeConversationAi,
  setConversationMode,
  takeoverConversation,
  updateCustomerMemory,
  deleteCustomerMemory,
  deleteConversationMessage,
  draftRemainingMs,
  disableCustomerMemory,
  isDraftExpired,
  isSyntheticDynamicFactOrderStatus,
  messageText,
  normalizeSendOutbox,
  parseKnowledgeCsv,
  resolveKnowledgeConflict,
  sendConversationMessage,
  startProductLearning,
  updateDynamicFactInventory,
  updateDynamicFactOrderStatus,
  updateShopAiMode,
  type Buyer,
} from './api';

describe('Phase 02 API boundary helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unwraps both bare arrays and named resource snapshots', () => {
    const buyers: Buyer[] = [{ id: 'buyer-1', displayName: '小林' }];

    expect(extractCollection<Buyer>(buyers, 'buyers')).toEqual(buyers);
    expect(extractCollection<Buyer>({ buyers }, 'buyers')).toEqual(buyers);
    expect(extractCollection<Buyer>({ data: buyers }, 'buyers')).toEqual(buyers);
  });

  it('reads text from the response shapes used by Message.contentJson', () => {
    expect(messageText({ text: '你好' })).toBe('你好');
    expect(messageText({ content: { text: '想问尺码' } })).toBe('想问尺码');
    expect(messageText({ contentJson: { text: '有库存吗？' } })).toBe('有库存吗？');
    expect(messageText({ contentJson: { body: '请帮我看看' } })).toBe('请帮我看看');
    expect(messageText({ contentJson: JSON.stringify({ text: '可以发顺丰吗？' }) })).toBe('可以发顺丰吗？');
  });

  it('attaches the opaque Workspace credential to resource requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ buyers: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await getBuyers('workspace-token', 'shop-1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/buyers?shopId=shop-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Demo-Workspace-Token': 'workspace-token',
        }),
      }),
    );
  });

  it('creates a MockDouyin shop and upgrades its AUTO policy through scoped shop endpoints', async () => {
    const shop = {
      id: 'shop-new',
      name: '演示新店',
      platform: 'DOUYIN_DEMO',
      externalShopId: 'demo-new',
      aiMode: 'ASSIST_ONLY',
      connectionState: 'CONNECTED',
      syncComplete: false,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(shop), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...shop, aiMode: 'AUTO_ALLOWED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await createShop('workspace-token', { platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: '演示新店' });
    await updateShopAiMode('workspace-token', 'shop-new', 'AUTO_ALLOWED');

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/shops', 'POST', JSON.stringify({ platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: '演示新店' })],
      ['/api/shops/shop-new/ai-mode', 'PATCH', JSON.stringify({ mode: 'AUTO_ALLOWED' })],
    ]);
  });

  it('soft-hides an AI or human message through the conversation-scoped endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'message-1', status: 'RECALLED', remoteRecalled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const deleted = await deleteConversationMessage('workspace-token', 'conversation-1', 'message-1', 'shop-1');

    expect(deleted).toMatchObject({ id: 'message-1', status: 'RECALLED' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation-1/messages/message-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ shopId: 'shop-1' }),
      }),
    );
  });

  it('parses the knowledge template and classifies normal, duplicate, conflict and error rows', () => {
    const csv = '\ufeff商品ID（可选）,问题,答案\n,多久发货？,普通现货商品通常在24小时内发出。\nP-F-001,可以烘干吗？,不建议使用烘干机。\nP-F-001,可以烘干吗？,不建议使用烘干机。\nP-F-001,可以烘干吗？,可以使用烘干机。\nP-F-001,,缺少问题';
    const rows = parseKnowledgeCsv(csv);
    const classified = classifyImportRows(rows, [
      { productId: 'P-F-001', question: '可以烘干吗？', answer: '不建议使用烘干机。' },
    ]);

    expect(rows).toHaveLength(5);
    expect(classified.map((row) => row.status)).toEqual(['READY', 'DUPLICATE', 'DUPLICATE', 'CONFLICT', 'ERROR']);
  });

  it('uses the shop batch endpoint for selected product learning and retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'job-1',
        shopId: 'shop-1',
        status: 'PENDING',
        totals: { total: 1, created: 0, updated: 0, skipped: 0, failed: 0 },
        items: [{ productId: 'product-1', status: 'PENDING', reason: null }],
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const job = await startProductLearning('workspace-token', 'shop-1', { productIds: ['product-1'], retryFailed: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shops/shop-1/product-learning-jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ productIds: ['product-1'], retryFailed: true }),
      }),
    );
    expect(job.items?.[0]).toMatchObject({ productId: 'product-1', status: 'PENDING' });
  });

  it('normalizes product learning totals and item outcomes for progress rendering', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobs: [{
        id: 'job-2',
        shopId: 'shop-1',
        status: 'PARTIAL_SUCCESS',
        totals: { total: 3, created: 1, updated: 1, skipped: 0, failed: 1 },
        items: [
          { productId: 'product-1', status: 'SUCCEEDED', reason: 'CREATED' },
          { productId: 'product-2', status: 'SUCCEEDED', reason: 'UPDATED' },
          { productId: 'product-3', status: 'FAILED', reason: 'NO_STABLE_PRODUCT_KNOWLEDGE' },
        ],
      }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const jobs = await getProductLearningJobs('workspace-token', 'shop-1');

    expect(jobs[0]).toMatchObject({ total: 3, completed: 2, failed: 1, progress: 67 });
    expect(jobs[0]?.items?.map((item) => item.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
  });

  it('normalizes the committed import snapshot and keeps its shop scope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'import-1',
        shopId: 'shop-1',
        status: 'COMMITTED',
        totals: { total: 2, valid: 1, duplicate: 1, conflict: 0, error: 0 },
        rows: [
          { rowNumber: 2, scope: 'STORE', question: '怎么洗？', answer: '冷水洗', status: 'COMMITTED' },
          { rowNumber: 3, scope: 'STORE', question: '怎么晾？', answer: '阴干', status: 'DUPLICATE', reason: '已有知识' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const snapshot = await commitKnowledgeImport('workspace-token', 'import-1', 'shop-1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/knowledge/imports/import-1/commit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ shopId: 'shop-1' }),
      }),
    );
    expect(snapshot).toMatchObject({ id: 'import-1', status: 'COMMITTED' });
    expect(snapshot.counts).toEqual({ ready: 1, duplicate: 1, conflict: 0, error: 0, total: 2 });
    expect(snapshot.rows[0]).toMatchObject({ status: 'READY' });
  });

  it('keeps candidate and conflict governance requests scoped to the selected shop', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes('/knowledge/candidates')) {
        return new Response(JSON.stringify([{ id: 'candidate-1', shopId: 'shop-1', source: 'AUTO_FAQ', proposedQuestion: '怎么洗？', proposedAnswer: '冷水洗', status: 'PENDING' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([{
        id: 'conflict-1',
        shopId: 'shop-1',
        leftItemId: 'left-1',
        rightItemId: 'right-1',
        leftVersionId: 'left-v1',
        rightVersionId: 'right-v1',
        left: { itemId: 'left-1', versionId: 'left-v1', version: 1, question: '材质是什么？', answer: '316L 不锈钢', indexStatus: 'READY' },
        right: { itemId: 'right-1', versionId: 'right-v1', version: 2, question: '材质是什么？', answer: '304 不锈钢', indexStatus: 'READY' },
        status: 'OPEN',
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const candidates = await getKnowledgeCandidates('workspace-token', { shopId: 'shop-1', status: 'PENDING' });
    const conflicts = await getKnowledgeConflicts('workspace-token', { shopId: 'shop-1', status: 'OPEN' });
    await resolveKnowledgeConflict('workspace-token', 'conflict-1', { shopId: 'shop-1', resolution: 'KEEP_LEFT' });

    expect(candidates[0]).toMatchObject({ id: 'candidate-1', proposedQuestion: '怎么洗？' });
    expect(conflicts[0]).toMatchObject({ id: 'conflict-1', leftItemId: 'left-1' });
    expect(conflicts[0]?.left).toMatchObject({
      itemId: 'left-1',
      versionId: 'left-v1',
      question: '材质是什么？',
      answer: '316L 不锈钢',
    });
    expect(conflicts[0]?.right).toMatchObject({
      itemId: 'right-1',
      versionId: 'right-v1',
      question: '材质是什么？',
      answer: '304 不锈钢',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/knowledge/conflicts/conflict-1/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ shopId: 'shop-1', resolution: 'KEEP_LEFT' }),
      }),
    );
  });

  it('posts explicit mode changes, takeover, resume and draft regeneration to the conversation boundary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ id: 'conversation-1', effectiveMode: 'MANUAL', humanActive: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await setConversationMode('workspace-token', 'conversation-1', 'shop-1', 'ASSIST');
    await takeoverConversation('workspace-token', 'conversation-1', 'shop-1');
    await resumeConversationAi('workspace-token', 'conversation-1', 'shop-1');
    await regenerateReply('workspace-token', 'conversation-1', 'shop-1');

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/conversations/conversation-1/mode', 'POST', JSON.stringify({ shopId: 'shop-1', mode: 'ASSIST' })],
      ['/api/conversations/conversation-1/takeover', 'POST', JSON.stringify({ shopId: 'shop-1' })],
      ['/api/conversations/conversation-1/resume-ai', 'POST', JSON.stringify({ shopId: 'shop-1' })],
      ['/api/conversations/conversation-1/reply/regenerate', 'POST', JSON.stringify({ shopId: 'shop-1' })],
    ]);
  });

  it('treats a Human Final 202 as a durable send receipt rather than a visible Message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sendOutboxId: 'outbox-1', candidateId: 'candidate-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const receipt = await sendConversationMessage('workspace-token', 'conversation-1', 'shop-1', {
      text: '已为您确认库存。',
      sourceDraftId: 'draft-1',
      editType: 'FACTUAL_CORRECTION',
    });

    expect(receipt).toMatchObject({ sendOutboxId: 'outbox-1', candidateId: 'candidate-1', status: 'ACCEPTED' });
    expect('id' in receipt).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ shopId: 'shop-1', text: '已为您确认库存。', sourceDraftId: 'draft-1', editType: 'FACTUAL_CORRECTION' }),
      }),
    );
  });

  it('normalizes a conversation snapshot with a draft and preserves its TTL metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'conversation-1',
        currentDraft: {
          id: 'draft-1',
          replyJobId: 'reply-job-1',
          aiDraft: '预计明天发出',
          humanFinal: null,
          editType: null,
          status: 'WAITING_HUMAN',
          sourceContextVersion: 4,
          expiresAt: '2026-08-27T10:05:00.000Z',
        },
        activeReplyJob: {
          id: 'reply-job-1',
          status: 'WAITING_HUMAN',
          sourceContextVersion: 4,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const snapshot = await getConversation('workspace-token', 'conversation-1');
    expect(snapshot.currentDraft).toMatchObject({
      id: 'draft-1',
      aiDraft: '预计明天发出',
      status: 'WAITING_HUMAN',
      sourceContextVersion: 4,
    });
    expect(snapshot.activeReplyJob).toMatchObject({ id: 'reply-job-1', status: 'WAITING_HUMAN' });
  });

  it('keeps customer memory operations workspace-scoped and sends the frozen value shape', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ memories: [{ id: 'memory-1', buyerId: 'buyer-1', shopId: 'shop-1', type: 'PREFERENCE', key: 'size', value: { text: 'XL' }, status: 'ACTIVE' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const memories = await getCustomerMemories('workspace-token', 'buyer-1', 'shop-1');
    expect(memories[0]).toMatchObject({ id: 'memory-1', buyerId: 'buyer-1', value: { text: 'XL' } });

    await updateCustomerMemory('workspace-token', 'memory-1', {
      shopId: 'shop-1',
      type: 'PREFERENCE',
      key: 'size',
      value: { text: 'L' },
    });
    await deleteCustomerMemory('workspace-token', 'memory-1', 'shop-1');

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/buyers/buyer-1/memories?shopId=shop-1', undefined, undefined],
      ['/api/memories/memory-1', 'PATCH', JSON.stringify({ shopId: 'shop-1', type: 'PREFERENCE', key: 'size', value: { text: 'L' } })],
      ['/api/memories/memory-1?shopId=shop-1', 'DELETE', undefined],
    ]);
  });

  it('normalizes customer memory create and disable responses from the current controllers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'memory-2', buyerId: 'buyer-1', shopId: 'shop-1', type: 'ONGOING_CASE', key: 'return',
        valueJson: { text: '待人工回访' }, status: 'ACTIVE',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'memory-2', status: 'DISABLED' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));

    const created = await createCustomerMemory('workspace-token', 'buyer-1', {
      shopId: 'shop-1', type: 'ONGOING_CASE', key: 'return', value: { text: '待人工回访' },
    });
    const disabled = await disableCustomerMemory('workspace-token', 'memory-2', 'shop-1');

    expect(created).toMatchObject({ id: 'memory-2', buyerId: 'buyer-1', value: { text: '待人工回访' } });
    expect(disabled).toMatchObject({ id: 'memory-2', status: 'DISABLED' });
    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/buyers/buyer-1/memories', 'POST', JSON.stringify({ shopId: 'shop-1', type: 'ONGOING_CASE', key: 'return', value: { text: '待人工回访' } })],
      ['/api/memories/memory-2/disable', 'POST', JSON.stringify({ shopId: 'shop-1' })],
    ]);
  });

  it('computes the five-minute Draft TTL and treats stale/expired drafts as non-sendable', () => {
    const now = Date.parse('2026-08-27T10:00:00.000Z');
    const draft = {
      status: 'WAITING_HUMAN' as const,
      generatedAt: '2026-08-27T09:56:00.000Z',
      expiresAt: null,
    };
    expect(draftRemainingMs(draft, now)).toBe(60_000);
    expect(isDraftExpired(draft, now)).toBe(false);
    expect(isDraftExpired(draft, now + 60_000)).toBe(true);
    expect(draftRemainingMs({ ...draft, status: 'STALE' }, now)).toBe(0);
  });

  it('preserves an UNCERTAIN send receipt for the Workbench recovery state', () => {
    expect(normalizeSendOutbox({
      id: 'outbox-1',
      status: 'UNCERTAIN',
      failureCode: 'SEND_TRANSPORT_UNKNOWN',
      failureReason: '平台响应未知',
    })).toMatchObject({
      id: 'outbox-1',
      status: 'UNCERTAIN',
      failureCode: 'SEND_TRANSPORT_UNKNOWN',
      failureReason: '平台响应未知',
    });
  });

  it('uses scoped synthetic dynamic-fact commands with strict order status input', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ACCEPTED', operationId: 'op-inventory' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ACCEPTED', operationId: 'op-order' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }));

    await updateDynamicFactInventory('workspace-token', 'shop-1', 'product-1', 'sku-1', 0);
    await updateDynamicFactOrderStatus('workspace-token', 'shop-1', 'order-1', 'SHIPPED');

    expect(isSyntheticDynamicFactOrderStatus('WAITING_SHIPMENT')).toBe(true);
    expect(isSyntheticDynamicFactOrderStatus('CANCELLED')).toBe(false);

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/shops/shop-1/dynamic-facts/products/product-1/skus/sku-1/inventory', 'PATCH', JSON.stringify({ inventory: 0 })],
      ['/api/shops/shop-1/dynamic-facts/orders/order-1/status', 'PATCH', JSON.stringify({ status: 'SHIPPED' })],
    ]);
  });

  it('does not send an order status outside the synthetic allowlist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(updateDynamicFactOrderStatus('workspace-token', 'shop-1', 'order-1', 'CANCELLED' as never)).rejects.toMatchObject({
      code: 'ORDER_STATUS_INVALID',
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
