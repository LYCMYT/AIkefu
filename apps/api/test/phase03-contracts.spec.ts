import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase 03 shared contracts', () => {
  it('binds product, knowledge, and usage event payloads by eventType', () => {
    const schema = JSON.parse(
      readFileSync(resolve(__dirname, '../../../specs/websocket-events.json'), 'utf8'),
    ) as { allOf?: Array<{ if?: { properties?: { eventType?: { const?: string } } }; then?: { properties?: { payload?: { $ref?: string } } } }> };

    const bindings = Object.fromEntries((schema.allOf ?? []).map((entry) => [
      entry.if?.properties?.eventType?.const,
      entry.then?.properties?.payload?.$ref,
    ]));
    expect(bindings).toMatchObject({
      PRODUCT_UPDATED: '#/$defs/ProductUpdatedPayload',
      KNOWLEDGE_UPDATED: '#/$defs/KnowledgeUpdatedPayload',
      USAGE_UPDATED: '#/$defs/UsageUpdatedPayload',
    });
  });

  it('keeps the frozen knowledge topK and attachment shop-isolation routes in OpenAPI', () => {
    const openapi = readFileSync(resolve(__dirname, '../../../specs/openapi.yaml'), 'utf8');

    expect(openapi).toMatch(/topK:\s*\{\s*type: integer, minimum: 1, maximum: 3\s*\}/);
    expect(openapi).toMatch(/\/attachments\/\{attachmentId\}\/signed-url:[\s\S]*?get:/);
    expect(openapi).toMatch(/\/attachments\/\{attachmentId\}:[\s\S]*?delete:/);
    const signedUrlPath = openapi.match(
      /  \/attachments\/\{attachmentId\}\/signed-url:[\s\S]*?(?=\n  \/|\ncomponents:)/,
    )?.[0];
    expect(signedUrlPath).toBeDefined();
    expect(signedUrlPath).not.toMatch(/^    delete:/m);
  });

  it('documents the conflict detail endpoint exposed by the controller', () => {
    const openapi = readFileSync(resolve(__dirname, '../../../specs/openapi.yaml'), 'utf8');
    const conflictDetailPath = openapi.match(
      /  \/knowledge\/conflicts\/\{conflictId\}:[\s\S]*?(?=\n  \/|\ncomponents:)/,
    )?.[0];

    expect(conflictDetailPath).toBeDefined();
    expect(conflictDetailPath).toMatch(/^    get:/m);
  });
});
