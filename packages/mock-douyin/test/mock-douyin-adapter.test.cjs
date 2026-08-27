const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MockDouyinAdapter,
  MockDouyinCredentialError,
} = require('../dist');

const scope = (overrides = {}) => ({
  workspaceId: 'workspace-a',
  tenantId: 'tenant-a',
  shopId: 'shop-a',
  ...overrides,
});

test('emits synthetic message, product-card and order-card events only to the matching scope', async () => {
  const adapter = new MockDouyinAdapter({ now: () => new Date('2026-08-27T00:00:00.000Z') });
  const received = [];
  adapter.subscribe(scope(), (event) => received.push(event));
  adapter.subscribe(scope({ workspaceId: 'workspace-b', tenantId: 'tenant-b' }), (event) => {
    throw new Error(`cross-workspace leak: ${event.eventId}`);
  });

  const text = await adapter.sendMessage({
    ...scope(),
    externalBuyerId: 'buyer-1',
    externalConversationId: 'conversation-1',
    text: '黑色 XL 还有吗？',
  });
  const productCard = await adapter.sendProductCard({
    ...scope(),
    externalBuyerId: 'buyer-1',
    externalConversationId: 'conversation-1',
    product: { externalProductId: 'P-1', title: '演示商品' },
  });
  const orderCard = await adapter.sendOrderCard({
    ...scope(),
    externalBuyerId: 'buyer-1',
    externalConversationId: 'conversation-1',
    order: { externalOrderId: 'O-1', status: 'SHIPPED' },
  });

  assert.equal(text.sequence, 1);
  assert.equal(productCard.sequence, 2);
  assert.equal(orderCard.sequence, 3);
  assert.deepEqual(received.map((event) => event.eventType), [
    'MESSAGE_CREATED',
    'MESSAGE_CREATED',
    'MESSAGE_CREATED',
  ]);
  assert.deepEqual(received.map((event) => event.payload.kind), ['TEXT', 'PRODUCT_CARD', 'ORDER_CARD']);
});

test('supports edit, recall, scoped history and one-gap reconciliation', async () => {
  const adapter = new MockDouyinAdapter({ now: () => new Date('2026-08-27T00:00:00.000Z') });
  const input = {
    ...scope(),
    externalBuyerId: 'buyer-1',
    externalConversationId: 'conversation-1',
  };
  const first = await adapter.sendMessage({ ...input, text: 'first' });
  await adapter.sendMessage({ ...input, text: 'second' });

  const edited = await adapter.editMessage({ ...scope(), externalMessageId: first.externalMessageId, text: 'edited' });
  const recalled = await adapter.recallMessage({ ...scope(), externalMessageId: first.externalMessageId });
  const history = await adapter.history({ ...scope(), externalConversationId: 'conversation-1' });
  const reconciliation = await adapter.reconcile({
    ...scope(),
    externalConversationId: 'conversation-1',
    expectedSequence: 1,
    throughSequence: 2,
  });

  assert.equal(edited.eventType, 'MESSAGE_EDITED');
  assert.equal(recalled.eventType, 'MESSAGE_RECALLED');
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].status, 'RECALLED');
  assert.deepEqual(reconciliation.messages.map((message) => message.sequence), [1, 2]);
  await assert.rejects(
    adapter.history({ ...scope({ workspaceId: 'workspace-b', tenantId: 'tenant-b' }), externalConversationId: 'conversation-1' }),
    /not found/i,
  );
});

test('rejects credential-shaped input and never exposes a real platform mode', async () => {
  assert.throws(
    () => new MockDouyinAdapter({ token: 'real-platform-token' }),
    MockDouyinCredentialError,
  );

  const adapter = new MockDouyinAdapter();
  await assert.rejects(
    adapter.sendMessage({
      ...scope(),
      externalBuyerId: 'buyer-1',
      externalConversationId: 'conversation-1',
      text: 'hello',
      authorization: 'Bearer secret',
    }),
    MockDouyinCredentialError,
  );
  assert.equal(adapter.descriptor.realPlatformAccess, false);
  assert.equal(adapter.descriptor.authentication, 'SYNTHETIC_WORKSPACE_ONLY');
});
