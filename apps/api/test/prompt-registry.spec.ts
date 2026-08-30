import { getPromptDefinition, listPromptDefinitions } from '../src/ai/prompt-registry';
import { validateStructuredOutput, type StructuredOutputSchemaName } from '@ai-customer-service/core';

const schemaForPurpose: Record<string, StructuredOutputSchemaName> = {
  INTENT_PLANNER: 'IntentPlan',
  RISK_CLASSIFIER: 'RiskResult',
  SUMMARY: 'ConversationSummary',
  KNOWLEDGE_EXTRACT: 'KnowledgeCandidate',
  REPLY_GENERATION: 'ReplyGeneration',
  IMAGE_ANALYSIS: 'ImageAnalysis',
  QUALITY_JUDGE: 'QualityReview',
};

describe('versioned prompt registry', () => {
  it('keeps every AI purpose reviewable in the repository', () => {
    const purposes = new Set(listPromptDefinitions().map((entry) => entry.purpose));
    expect(purposes).toEqual(new Set([
      'INTENT_PLANNER', 'RISK_CLASSIFIER', 'SUMMARY', 'KNOWLEDGE_EXTRACT',
      'REPLY_GENERATION', 'IMAGE_ANALYSIS', 'QUALITY_JUDGE',
    ]));
    for (const entry of listPromptDefinitions()) {
      expect(entry.system.length).toBeGreaterThan(80);
      expect(entry.instructions.length).toBeGreaterThan(40);
      expect(entry.instructions).toContain('Output exactly:');
      expect(entry.version).toMatch(/-v\d+$/);
    }
  });

  it('resolves only the declared purpose/version pair', () => {
    expect(getPromptDefinition('REPLY_GENERATION', 'reply-composer-v1')).toMatchObject({
      purpose: 'REPLY_GENERATION', version: 'reply-composer-v1',
    });
    expect(() => getPromptDefinition('RISK_CLASSIFIER', 'reply-composer-v1')).toThrow('PROMPT_NOT_REGISTERED');
  });

  it('keeps every Output exactly example valid against the runtime structured-output validator', () => {
    for (const definition of listPromptDefinitions()) {
      const matched = definition.instructions.match(/Output exactly:\s*(\{.*\})\./);
      expect(matched?.[1]).toBeDefined();
      const example = JSON.parse(matched![1]!);
      if (!validateStructuredOutput(schemaForPurpose[definition.purpose]!, example)) {
        throw new Error(`INVALID_PROMPT_EXAMPLE: ${definition.purpose}/${definition.version}`);
      }
      if (definition.purpose === 'SUMMARY') {
        expect(example.resolvedFacts).toEqual([
          { key: 'preferred_fit', value: '宽松', sourceMessageId: 'message-example', status: 'ACTIVE' },
        ]);
      }
    }
  });
});
