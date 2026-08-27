export type EffectiveConversationMode = 'AUTO' | 'ASSIST' | 'MANUAL';

/** Shared REST/WS projection; reply policy remains the final send-time gate. */
export function effectiveConversationMode(conversation: {
  mode: string;
  overrideMode?: string | null;
  humanActive: boolean;
  syncState: string;
  shop?: { aiMode?: string } | null;
}): EffectiveConversationMode {
  const rank = { AUTO: 0, ASSIST: 1, MANUAL: 2 } as const;
  let selected: EffectiveConversationMode = conversation.mode === 'AUTO' ? 'AUTO'
    : conversation.mode === 'MANUAL' || conversation.mode === 'HOLD' ? 'MANUAL' : 'ASSIST';
  const ceiling = conversation.shop?.aiMode === 'AUTO_ALLOWED' ? 'AUTO'
    : conversation.shop?.aiMode === 'MANUAL_ONLY' ? 'MANUAL' : 'ASSIST';
  const override = conversation.overrideMode === 'AUTO' || conversation.overrideMode === 'ASSIST'
    ? conversation.overrideMode
    : conversation.overrideMode === 'MANUAL' || conversation.overrideMode === 'HOLD' ? 'MANUAL' : undefined;
  for (const cap of [ceiling, override, conversation.humanActive ? 'MANUAL' : undefined,
    conversation.syncState === 'DEGRADED' || conversation.syncState === 'DISCONNECTED' ? 'MANUAL' : undefined] as Array<EffectiveConversationMode | undefined>) {
    if (cap && rank[cap] > rank[selected]) selected = cap;
  }
  return selected;
}
