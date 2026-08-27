export type HumanFinalSubmission =
  | { allowed: true; sourceDraftId?: string }
  | { allowed: false };

export function humanFinalSubmission(input: {
  humanActive: boolean;
  sourceDraftId?: string | null;
}): HumanFinalSubmission {
  const sourceDraftId = input.sourceDraftId?.trim();
  if (sourceDraftId) return { allowed: true, sourceDraftId };
  return input.humanActive ? { allowed: true } : { allowed: false };
}

export function buyerTextSubmissionEnabled(input: {
  text: string;
  shopId?: string | null;
  buyerId?: string | null;
  loading: boolean;
  sending: boolean;
}): boolean {
  return Boolean(input.text.trim() && input.shopId && input.buyerId && !input.loading && !input.sending);
}
