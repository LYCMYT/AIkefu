import { ConversationTransportMutex, transportMutexKey, transportShopMutexKey } from '../src/replies/conversation-transport-mutex.service';

describe('ConversationTransportMutex', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('makes an inbound writer wait for an in-flight Mock transport hand-off, then serialize after its receipt boundary', async () => {
    const mutex = new ConversationTransportMutex();
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { releaseSend = resolve; });
    const entered: string[] = [];
    const keys = [transportShopMutexKey(scope), transportMutexKey(scope, 'conversation-a')];
    const sending = mutex.runMany(keys, async () => {
      entered.push('send:marker');
      await sendStarted;
      entered.push('send:receipt');
    });
    await Promise.resolve();
    const inbound = mutex.runMany(keys, async () => { entered.push('inbound:context-version'); });
    await Promise.resolve();
    expect(entered).toEqual(['send:marker']);

    releaseSend();
    await Promise.all([sending, inbound]);
    expect(entered).toEqual(['send:marker', 'send:receipt', 'inbound:context-version']);
  });

  it('makes send wait when a scoped writer wins first, so no adapter hand-off begins against old context', async () => {
    const mutex = new ConversationTransportMutex();
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const entered: string[] = [];
    const keys = [transportShopMutexKey(scope), transportMutexKey(scope, 'conversation-a')];
    const writer = mutex.runMany(keys, async () => { entered.push('writer:context-version'); await writerGate; });
    await Promise.resolve();
    const send = mutex.runMany(keys, async () => { entered.push('send:adapter'); });
    await Promise.resolve();
    expect(entered).toEqual(['writer:context-version']);

    releaseWriter();
    await Promise.all([writer, send]);
    expect(entered).toEqual(['writer:context-version', 'send:adapter']);
  });
});
