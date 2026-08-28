import { describe, expect, it } from 'vitest';
import { buyerTextSubmissionEnabled, canSoftRemoveMessage, humanFinalSubmission } from './workbench-actions';

describe('Workbench human-final submission policy', () => {
  it('allows a manual takeover to send without an AI draft', () => {
    expect(humanFinalSubmission({ humanActive: true })).toEqual({ allowed: true });
  });

  it('requires an editable draft before takeover and preserves its id', () => {
    expect(humanFinalSubmission({ humanActive: false })).toEqual({ allowed: false });
    expect(humanFinalSubmission({ humanActive: false, sourceDraftId: 'draft-a' })).toEqual({
      allowed: true,
      sourceDraftId: 'draft-a',
    });
  });
});

describe('Buyer Simulator send policy', () => {
  it('fails closed while the selected shop or buyer scope is being refreshed', () => {
    expect(buyerTextSubmissionEnabled({ text: '你好', shopId: 'shop-a', buyerId: 'buyer-a', loading: false, sending: false })).toBe(true);
    expect(buyerTextSubmissionEnabled({ text: '你好', shopId: 'shop-a', buyerId: '', loading: false, sending: false })).toBe(false);
    expect(buyerTextSubmissionEnabled({ text: '你好', shopId: 'shop-a', buyerId: 'buyer-a', loading: true, sending: false })).toBe(false);
  });
});

describe('Workbench message removal policy', () => {
  it('offers a soft-remove action for visible buyer and reply messages', () => {
    expect(canSoftRemoveMessage({ role: 'BUYER', status: 'ACTIVE' })).toBe(true);
    expect(canSoftRemoveMessage({ role: 'ASSISTANT', status: 'ACTIVE' })).toBe(true);
    expect(canSoftRemoveMessage({ role: 'HUMAN', status: 'EDITED' })).toBe(true);
  });

  it('keeps system and already removed messages immutable in the UI', () => {
    expect(canSoftRemoveMessage({ role: 'SYSTEM', status: 'ACTIVE' })).toBe(false);
    expect(canSoftRemoveMessage({ role: 'BUYER', status: 'RECALLED' })).toBe(false);
    expect(canSoftRemoveMessage({ role: 'ASSISTANT', status: 'DELETED' })).toBe(false);
  });
});
