import { getPromptDefinition, listPromptDefinitions } from '../src/ai/prompt-registry';

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
});
