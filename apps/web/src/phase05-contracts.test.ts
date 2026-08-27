import { describe, expect, it } from 'vitest';
import openapiText from '../../../specs/openapi.yaml?raw';
import websocketSchema from '../../../specs/websocket-events.json';
import type {
  ScenarioUpdatedPayload,
  TypedWorkspaceEventEnvelope,
} from '@ai-customer-service/contracts';

describe('Phase 05 OpenAPI and WebSocket contracts', () => {
  it('declares strict workflow, approval, quality, incident, trace and scenario routes', () => {
    expect(openapiText).toContain('/workflows/{workflowId}:');
    expect(openapiText).toContain('/workflows/{workflowId}/enable:');
    expect(openapiText).toContain('/workflows/{workflowId}/disable:');
    expect(openapiText).toContain('/workflow-runs/{runId}:');
    expect(openapiText).toContain('/quality/reviews/{reviewId}:');
    expect(openapiText).toContain('/quality/reviews/{reviewId}/conclusion:');
    expect(openapiText).toContain('/incidents/{incidentId}/resolve:');
    expect(openapiText).toContain('/incidents/{incidentId}/add-regression:');
    expect(openapiText).toContain('/incidents/{incidentId}/root-cause:');
    expect(openapiText).toContain('  /incidents:\n    parameters:\n      - in: query\n        name: conversationId');
    expect(openapiText).toContain('name: status');
    expect(openapiText).toContain('name: severity');
    expect(openapiText).toContain('/conversations/{conversationId}/trace:');
    expect(openapiText).toContain('required: [nodes, edges, settings]');
    expect(openapiText).toContain('    NodeRun:');
    expect(openapiText).toContain('    ActionProposal:');
    expect(openapiText).toContain('    QualityDeterministicResult:');
    expect(openapiText).toContain('    QualityConclusionInput:');
    expect(openapiText).toContain('    TraceEvent:');
    expect(openapiText).toContain('    ScenarioStep:');
    expect(openapiText).toContain('    RootCauseInput:');
    expect(openapiText).toContain('trace:');
    expect(openapiText).toContain('x-demo-only: true');
    expect(openapiText).toContain('x-synthetic: true');
  });

  it('declares the workspace-scoped delete-customer-data route and count result', () => {
    expect(openapiText).toContain('  /buyers/{buyerId}/customer-data:');
    expect(openapiText).toContain('summary: Delete and anonymize customer data');
    expect(openapiText).toContain('$ref: "#/components/schemas/CustomerDataDeletionResult"');
    expect(openapiText).toContain('CustomerDataDeletionResult:');
    expect(openapiText).toContain('customerMemories: { type: integer, minimum: 0 }');
    expect(openapiText).toContain('knowledgeCandidates: { type: integer, minimum: 0 }');
    expect(openapiText).toContain('anonymousAggregates: { type: integer, minimum: 0 }');
  });

  it('has a typed payload binding for every Phase 05 event family', () => {
    const runEvent: TypedWorkspaceEventEnvelope<'WORKFLOW_RUN_UPDATED'> = {
      eventId: 'event-1',
      eventType: 'WORKFLOW_RUN_UPDATED',
      workspaceId: 'workspace-1',
      entityType: 'WORKFLOW_RUN',
      entityId: 'run-1',
      entityVersion: 1,
      occurredAt: '2026-08-27T10:00:00.000Z',
      payload: { workflowRun: {} as never },
    };
    const scenarioPayload: ScenarioUpdatedPayload = {
      scenarioKey: 'continuous_messages',
      status: 'RUNNING',
    };

    expect(runEvent.payload.workflowRun).toBeDefined();
    expect(scenarioPayload.scenarioKey).toBe('continuous_messages');
  });

  it('discriminates Phase 05 WebSocket payloads in the JSON schema', () => {
    const schema = websocketSchema as {
      allOf?: Array<{ if?: { properties?: { eventType?: { const?: string } } }; then?: unknown }>;
      $defs?: Record<string, unknown>;
    };
    const eventTypes = new Set((schema.allOf ?? []).map((branch) => branch.if?.properties?.eventType?.const));
    for (const eventType of [
      'WORKFLOW_RUN_UPDATED',
      'WORKFLOW_NODE_UPDATED',
      'ACTION_PROPOSAL_UPDATED',
      'QUALITY_REVIEW_UPDATED',
      'REPLY_INCIDENT_UPDATED',
      'SCENARIO_UPDATED',
    ]) {
      expect(eventTypes.has(eventType)).toBe(true);
    }
    expect(schema.$defs).toEqual(expect.objectContaining({
      WorkflowRunUpdatedPayload: expect.anything(),
      WorkflowNodeUpdatedPayload: expect.anything(),
      ActionProposalUpdatedPayload: expect.anything(),
      QualityReviewUpdatedPayload: expect.anything(),
      ReplyIncidentUpdatedPayload: expect.anything(),
      ScenarioUpdatedPayload: expect.anything(),
    }));
  });

  it('keeps every OpenAPI array item and local component reference resolvable', () => {
    const lines = openapiText.split(/\r?\n/);
    const indentOf = (line: string) => line.length - line.trimStart().length;
    const nextMeaningfulLine = (from: number) => {
      for (let index = from + 1; index < lines.length; index += 1) {
        if (lines[index]?.trim() && !lines[index]?.trim().startsWith('#')) return index;
      }
      return -1;
    };

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.trim() !== 'type: array') continue;
      const typeIndent = indentOf(lines[index] ?? '');
      let itemsIndex = -1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor] ?? '';
        if (!line.trim() || line.trim().startsWith('#')) continue;
        if (indentOf(line) < typeIndent) break;
        if (indentOf(line) === typeIndent && line.trim().startsWith('items:')) {
          itemsIndex = cursor;
          break;
        }
      }
      expect(itemsIndex, `array at line ${index + 1} must declare items`).toBeGreaterThan(-1);
      if (itemsIndex < 0) continue;
      const itemsLine = lines[itemsIndex] ?? '';
      const inlineItems = itemsLine.slice(itemsLine.indexOf('items:') + 'items:'.length).trim();
      if (inlineItems) {
        expect(inlineItems).not.toBe('null');
      } else {
        const childIndex = nextMeaningfulLine(itemsIndex);
        expect(childIndex, `array items at line ${itemsIndex + 1} must not be empty`).toBeGreaterThan(-1);
        if (childIndex >= 0) expect(indentOf(lines[childIndex] ?? '')).toBeGreaterThan(indentOf(itemsLine));
      }
    }

    const componentNames = new Set<string>();
    const componentStart = lines.findIndex((line) => line === 'components:');
    expect(componentStart).toBeGreaterThan(-1);
    if (componentStart >= 0) {
      for (let index = componentStart + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line && indentOf(line) === 2 && line.trim().endsWith(':')) {
          const section = line.trim().slice(0, -1);
          if (!['schemas', 'parameters', 'responses', 'securitySchemes', 'headers', 'examples', 'requestBodies', 'links', 'callbacks'].includes(section)) continue;
        }
        const match = line.match(/^    ([A-Za-z][A-Za-z0-9_-]*):\s*$/);
        if (match) componentNames.add(match[1] ?? '');
      }
    }
    for (const match of openapiText.matchAll(/#\/components\/(schemas|parameters|responses)\/([A-Za-z0-9_-]+)/g)) {
      expect(componentNames.has(match[2] ?? ''), `unresolved OpenAPI ref ${match[0]}`).toBe(true);
    }
  });
});
