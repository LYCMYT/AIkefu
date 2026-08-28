import { effectiveConversationMode } from '../src/replies/effective-conversation-mode';

describe('effectiveConversationMode AUTO projection', () => {
  it('projects explicit AUTO after the service persists AUTO as the base and the Shop allows it', () => {
    expect(effectiveConversationMode({
      mode: 'AUTO', overrideMode: 'AUTO', humanActive: false, syncState: 'CONNECTED',
      shop: { aiMode: 'AUTO_ALLOWED' },
    })).toBe('AUTO');
  });

  it('still fails closed when the Shop ceiling is lowered', () => {
    expect(effectiveConversationMode({
      mode: 'AUTO', overrideMode: 'AUTO', humanActive: false, syncState: 'CONNECTED',
      shop: { aiMode: 'ASSIST_ONLY' },
    })).toBe('ASSIST');
  });
});
