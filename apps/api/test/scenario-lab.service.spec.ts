import { ScenarioLabService } from '../src/scenarios/scenario-lab.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

function createService() {
  const prisma = {
    traceEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'trace-event-1' }),
    },
  };
  const gateway = { publish: jest.fn() };
  const messages = {};
  const invalidation = {};
  const seeds = { load: jest.fn().mockResolvedValue({}) };
  const recovery = {};
  const sends = {};
  const service = new ScenarioLabService(
    prisma as never,
    messages as never,
    invalidation as never,
    gateway as never,
    seeds as never,
    recovery as never,
    sends as never,
  );
  return { service, prisma, gateway };
}

describe('ScenarioLabService', () => {
  it('exposes exactly the eight frozen synthetic scenarios with observable steps', async () => {
    const { service } = createService();

    const scenarios = await service.list(scope);

    expect(scenarios).toHaveLength(8);
    expect(scenarios.map((scenario) => scenario.key)).toEqual([
      'continuous_messages',
      'message_during_generation',
      'two_buyers',
      'two_shops',
      'duplicate_and_reorder',
      'ai_timeout_fallback',
      'service_restart_recovery',
      'realtime_state_change',
    ]);
    expect(scenarios.every((scenario) => scenario.synthetic === true)).toBe(true);
    expect(scenarios.every((scenario) => scenario.steps && scenario.steps.length > 0)).toBe(true);
  });

  it('returns the same operation for an idempotent run and never crosses workspace snapshot state', async () => {
    const { service, prisma } = createService();
    const execute = jest.spyOn(service as never, 'executeScenario' as never).mockResolvedValue({ resources: {} } as never);

    const first = await service.run(scope, 'continuous_messages');
    const second = await service.run(scope, 'continuous_messages');
    const otherWorkspace = await service.run({ workspaceId: 'workspace-b', tenantId: 'tenant-b' }, 'continuous_messages');

    expect(first).toEqual({ operationId: expect.any(String), status: 'ACCEPTED' });
    expect(second).toEqual(first);
    expect(otherWorkspace.operationId).not.toBe(first.operationId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(prisma.traceEvent.create).toHaveBeenCalled();
  });

  it('publishes scoped SCENARIO_UPDATED events for run and step transitions', async () => {
    const { service, gateway } = createService();
    jest.spyOn(service as never, 'executeScenario' as never).mockResolvedValue({ resources: {} } as never);

    await service.run(scope, 'duplicate_and_reorder');

    const events = gateway.publish.mock.calls.map(([event]) => event);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event: { workspaceId: string; eventType: string; entityType: string }) =>
      event.workspaceId === scope.workspaceId && event.eventType === 'SCENARIO_UPDATED' && event.entityType === 'SCENARIO')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      workspaceId: scope.workspaceId,
      entityId: 'duplicate_and_reorder',
      payload: { scenarioKey: 'duplicate_and_reorder', status: 'SUCCEEDED' },
    });
  });

  it('reset is scoped and idempotent', async () => {
    const { service } = createService();
    jest.spyOn(service as never, 'executeScenario' as never).mockResolvedValue({ resources: {} } as never);

    const first = await service.reset(scope, 'two_shops');
    const second = await service.reset(scope, 'two_shops');

    expect(first).toEqual({ operationId: expect.any(String), status: 'ACCEPTED' });
    expect(second).toEqual(first);
  });
});
