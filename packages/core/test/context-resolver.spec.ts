import { resolveContext } from '../src';

describe('ContextResolver', () => {
  const product = (id: string) => ({ id, kind: 'PRODUCT' as const, label: `product ${id}` });

  it('prefers a valid product card over otherwise ambiguous candidates', () => {
    expect(resolveContext({
      kind: 'PRODUCT',
      riskLevel: 'LOW',
      candidates: [product('p-card'), product('p-other')],
      card: { kind: 'PRODUCT', id: 'p-card' },
    })).toEqual(expect.objectContaining({ status: 'RESOLVED', entity: product('p-card'), source: 'CARD' }));
  });

  it('never guesses between candidates and asks at most two low/medium-risk clarification rounds', () => {
    const input = { kind: 'ORDER' as const, riskLevel: 'MEDIUM' as const, candidates: [
      { id: 'o-1', kind: 'ORDER' as const, label: 'order 1' },
      { id: 'o-2', kind: 'ORDER' as const, label: 'order 2' },
    ] };

    expect(resolveContext({ ...input, clarificationRounds: 0 })).toMatchObject({
      status: 'AMBIGUOUS',
      manualRequired: false,
      clarification: { round: 1, choices: [{ id: 'o-1' }, { id: 'o-2' }] },
    });
    expect(resolveContext({ ...input, clarificationRounds: 1 })).toMatchObject({
      status: 'AMBIGUOUS',
      manualRequired: false,
      clarification: { round: 2 },
    });
    expect(resolveContext({ ...input, clarificationRounds: 2 })).toMatchObject({
      status: 'AMBIGUOUS',
      manualRequired: true,
      clarification: null,
    });
  });

  it('returns NOT_FOUND, STALE, and direct-manual high-risk outcomes rather than fabricating context', () => {
    expect(resolveContext({ kind: 'SKU', riskLevel: 'LOW', candidates: [] })).toMatchObject({ status: 'NOT_FOUND' });
    expect(resolveContext({
      kind: 'PRODUCT', riskLevel: 'LOW', candidates: [product('p-1')], contextVersion: 4, currentContextVersion: 5,
    })).toMatchObject({ status: 'STALE' });
    expect(resolveContext({
      kind: 'ORDER', riskLevel: 'HIGH', candidates: [
        { id: 'o-1', kind: 'ORDER', label: 'order 1' },
        { id: 'o-2', kind: 'ORDER', label: 'order 2' },
      ],
    })).toMatchObject({ status: 'AMBIGUOUS', manualRequired: true, clarification: null });
  });
});
