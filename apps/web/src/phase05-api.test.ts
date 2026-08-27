import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveActionProposal,
  addIncidentRegression,
  concludeQualityReview,
  deleteCustomerData,
  disableCustomerMemory,
  getConversationTrace,
  getDeveloperTrace,
  getIncidents,
  getQualityReviews,
  getScenarios,
  getUsageSummary,
  getWorkflow,
  getWorkflowRuns,
  getWorkflows,
  mergeCustomerMemoryMutation,
  rejectActionProposal,
  runScenario,
  resolveIncident,
  saveIncidentCorrection,
  saveIncidentRootCause,
  startQualityReview,
  type CustomerMemory,
} from './api';

describe('Phase 05 Web API boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the real Phase 05 resource collections and workflow detail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      const payload = path.endsWith('/workflows')
        ? [{ id: 'workflow-1', name: '商品推荐', status: 'PUBLISHED', priority: 60 }]
        : path.includes('/workflow-runs')
          ? [{ id: 'run-1', workflowVersionId: 'version-1', status: 'RUNNING', shopId: 'shop-1', conversationId: 'conversation-1', taskIds: [], contextVersion: 1, completedNodeIds: [], startedAt: '2026-08-27T10:00:00.000Z' }]
          : { id: 'workflow-1', name: '商品推荐', status: 'PUBLISHED', priority: 60 };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const workflows = await getWorkflows('workspace-token');
    const workflow = await getWorkflow('workspace-token', 'workflow-1');
    const runs = await getWorkflowRuns('workspace-token', { conversationId: 'conversation-1' });

    expect(workflows[0]).toMatchObject({ id: 'workflow-1', priority: 60 });
    expect(workflow).toMatchObject({ id: 'workflow-1', status: 'PUBLISHED' });
    expect(runs[0]).toMatchObject({ id: 'run-1', workflowVersionId: 'version-1' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/workflows',
      '/api/workflows/workflow-1',
      '/api/workflow-runs?conversationId=conversation-1',
    ]);
  });

  it('keeps quality, incident, usage and scenario reads as real API snapshots', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      const payload = path.includes('/quality/reviews')
        ? [{ id: 'review-1', conversationId: 'conversation-1', status: 'PENDING' }]
        : path.includes('/incidents')
          ? [{ id: 'incident-1', replyId: 'reply-1', errorType: 'WRONG_FACT', severity: 'HIGH', status: 'OPEN' }]
          : path.includes('/scenarios')
            ? [{ key: 'continuous_messages', name: '连续消息聚合', status: 'READY', synthetic: true, steps: [] }]
            : { calls: 2, inputTokens: 10, outputTokens: 4, estimatedCost: 0, failures: 1, fallbacks: 1, fastPathReplies: 1, byPurpose: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    expect((await getQualityReviews('workspace-token'))[0]).toMatchObject({ id: 'review-1' });
    expect((await getIncidents('workspace-token'))[0]).toMatchObject({ id: 'incident-1' });
    expect(await getUsageSummary('workspace-token')).toMatchObject({ calls: 2, fallbacks: 1 });
    expect((await getScenarios('workspace-token'))[0]).toMatchObject({ key: 'continuous_messages', synthetic: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses trace=1 explicitly and preserves trace scope for reply or conversation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ traceId: 'trace-1', events: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await getDeveloperTrace('workspace-token', 'reply-1');
    await getConversationTrace('workspace-token', 'conversation-1');

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/replies/reply-1/trace?trace=1',
      '/api/conversations/conversation-1/trace?trace=1',
    ]);
  });

  it('requires 202 receipts for approval, rejection, quality and scenario commands', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ operationId: 'op-1', status: 'ACCEPTED' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await approveActionProposal('workspace-token', 'proposal-1', { expectedContextVersion: 4 });
    await rejectActionProposal('workspace-token', 'proposal-1', { reason: '人工拒绝' });
    await startQualityReview('workspace-token', 'conversation-1');
    await concludeQualityReview('workspace-token', 'review-1', 'PASS');
    await saveIncidentCorrection('workspace-token', 'incident-1', { correctedAnswer: '人工修正', sendToBuyer: true });
    await saveIncidentRootCause('workspace-token', 'incident-1', '根因说明');
    await addIncidentRegression('workspace-token', 'incident-1', 'case-1');
    await resolveIncident('workspace-token', 'incident-1');
    await runScenario('workspace-token', 'continuous_messages');

    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.body])).toEqual([
      ['/api/action-proposals/proposal-1/approve', 'POST', JSON.stringify({ expectedContextVersion: 4 })],
      ['/api/action-proposals/proposal-1/reject', 'POST', JSON.stringify({ reason: '人工拒绝' })],
      ['/api/quality/reviews', 'POST', JSON.stringify({ conversationId: 'conversation-1' })],
      ['/api/quality/reviews/review-1/conclusion', 'POST', JSON.stringify({ result: 'PASS' })],
      ['/api/incidents/incident-1/correction', 'POST', JSON.stringify({ correctedAnswer: '人工修正', sendToBuyer: true })],
      ['/api/incidents/incident-1/root-cause', 'POST', JSON.stringify({ rootCause: '根因说明' })],
      ['/api/incidents/incident-1/add-regression', 'POST', JSON.stringify({ caseId: 'case-1' })],
      ['/api/incidents/incident-1/resolve', 'POST', undefined],
      ['/api/scenarios/continuous_messages/run', 'POST', undefined],
    ]);
  });

  it('merges a partial CustomerMemory disable response instead of creating an empty card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'memory-1', status: 'DISABLED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const current: CustomerMemory = {
      id: 'memory-1',
      buyerId: 'buyer-1',
      shopId: 'shop-1',
      type: 'PREFERENCE',
      key: 'size',
      value: { text: 'XL' },
      status: 'ACTIVE',
    };

    const mutation = await disableCustomerMemory('workspace-token', 'memory-1', 'shop-1');
    expect(mergeCustomerMemoryMutation(current, mutation)).toEqual({ ...current, status: 'DISABLED' });
  });

  it('deletes customer data through the workspace-scoped route and preserves the result counts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        buyerId: 'buyer-1',
        status: 'COMPLETED',
        deleted: { conversations: 2, messages: 12, attachments: 3, customerMemories: 1, knowledgeCandidates: 1 },
        anonymized: { buyers: 1, orders: 4 },
        preserved: { anonymousAggregates: 1, auditFacts: 1 },
        completedAt: '2026-08-27T10:00:00.000Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await deleteCustomerData('workspace-token', 'buyer-1');

    expect(result).toMatchObject({
      buyerId: 'buyer-1',
      status: 'COMPLETED',
      deleted: { conversations: 2, messages: 12, attachments: 3, customerMemories: 1, knowledgeCandidates: 1 },
      anonymized: { buyers: 1, orders: 4 },
      preserved: { anonymousAggregates: 1, auditFacts: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/buyers/buyer-1/customer-data',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Demo-Workspace-Token': 'workspace-token',
        }),
      }),
    );
  });

  it('does not issue a destructive request for an empty buyer id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(deleteCustomerData('workspace-token', '  ')).rejects.toMatchObject({
      code: 'BUYER_ID_REQUIRED',
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
