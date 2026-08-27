import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { MESSAGE_APPLICATION } from '../src/messages/message.application';
import { WorkspaceGateway } from '../src/websocket/workspace.gateway';
import { WORKSPACE_REPOSITORY } from '../src/workspaces/workspace.repository';
import { InMemoryMessageApplication } from './message.application.fake';
import { InMemoryWorkspaceRepository } from './workspace.repository.fake';

describe('Phase 02 message vertical slice', () => {
  let app: INestApplication;
  let baseUrl: string;
  let workspaceRepository: InMemoryWorkspaceRepository;
  let messages: InMemoryMessageApplication;
  let token: string;
  let shops: Array<{ id: string; name: string }>;
  let buyers: Array<{ id: string; displayName: string }>;

  beforeEach(async () => {
    workspaceRepository = new InMemoryWorkspaceRepository();
    messages = new InMemoryMessageApplication(workspaceRepository);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WORKSPACE_REPOSITORY)
      .useValue(workspaceRepository)
      .overrideProvider(MESSAGE_APPLICATION)
      .useValue(messages)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    messages.setPublisher(app.get(WorkspaceGateway));
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'string' ? 0 : address.port}`;

    const session = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    token = session.token;
    shops = (
      await request(app.getHttpServer()).get('/api/shops').set('X-Demo-Workspace-Token', token).expect(200)
    ).body;
    buyers = (
      await request(app.getHttpServer()).get('/api/buyers').set('X-Demo-Workspace-Token', token).expect(200)
    ).body;
  });

  afterEach(async () => {
    await app.close();
  });

  it('deduplicates and commits 101/103/102 in sequence', async () => {
    await sendText(shops[0]!.id, buyers[0]!.id, '101', 101, 'ext-101');
    await sendText(shops[0]!.id, buyers[0]!.id, '103', 103, 'ext-103');
    let snapshot = await onlyConversation(shops[0]!.id);
    expect(snapshot.messages.map((message: { sequence: number }) => message.sequence)).toEqual([101]);

    await sendText(shops[0]!.id, buyers[0]!.id, '102', 102, 'ext-102');
    await sendText(shops[0]!.id, buyers[0]!.id, 'duplicate', 102, 'ext-102');
    snapshot = await onlyConversation(shops[0]!.id);

    expect(snapshot.messages.map((message: { sequence: number }) => message.sequence)).toEqual([101, 102, 103]);
    expect(messages.processingOutboxCount()).toBe(3);
    expect(snapshot.syncState).toBe('CONNECTED');
  });

  it('marks an unresolved gap DEGRADED and accepts the late missing message', async () => {
    await sendText(shops[0]!.id, buyers[1]!.id, '201', 201, 'gap-201');
    await sendText(shops[0]!.id, buyers[1]!.id, '203', 203, 'gap-203');
    await messages.advanceBy(1_001);

    let snapshot = await onlyConversation(shops[0]!.id, buyers[1]!.id);
    expect(snapshot.syncState).toBe('DEGRADED');

    await sendText(shops[0]!.id, buyers[1]!.id, '202 late', 202, 'gap-202');
    snapshot = await onlyConversation(shops[0]!.id, buyers[1]!.id);
    expect(snapshot.messages.map((message: { sequence: number }) => message.sequence)).toEqual([201, 202, 203]);
    expect(snapshot.syncState).toBe('CONNECTED');
    expect(snapshot.contextVersion).toBeGreaterThan(1);
  });

  it('persists one UserTurn for continuous messages and recovers a lost delayed schedule', async () => {
    await sendText(shops[0]!.id, buyers[2]!.id, '黑色有吗');
    await messages.advanceBy(500);
    await sendText(shops[0]!.id, buyers[2]!.id, 'XL呢');
    await messages.advanceBy(500);
    await sendText(shops[0]!.id, buyers[2]!.id, '我165，55公斤');
    messages.clearDelayedJobsForRestart();
    await messages.recoverTurnBuffers();
    await messages.advanceBy(2_001);

    const snapshot = await onlyConversation(shops[0]!.id, buyers[2]!.id);
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.userTurns).toHaveLength(1);
    expect(snapshot.userTurns[0].sourceMessageIds).toHaveLength(3);
    expect(snapshot.userTurns[0].normalizedText).toContain('XL呢');
  });

  it('projects a truly late message as its own UserTurn without reopening the completed range', async () => {
    await sendText(shops[0]!.id, buyers[2]!.id, '50', 50, 'late-50');
    await sendText(shops[0]!.id, buyers[2]!.id, '51', 51, 'late-51');
    await messages.advanceBy(2_001);

    await sendText(shops[0]!.id, buyers[2]!.id, '49 late', 49, 'late-49');
    const snapshot = await onlyConversation(shops[0]!.id, buyers[2]!.id);

    expect(snapshot.userTurns).toHaveLength(2);
    expect(snapshot.userTurns[0].sourceMessageIds).toHaveLength(2);
    expect(snapshot.userTurns[1]).toMatchObject({
      firstSequence: 49,
      lastSequence: 49,
      normalizedText: '49 late',
    });
  });

  it('keeps two buyers and two shops isolated', async () => {
    await Promise.all([
      sendText(shops[0]!.id, buyers[0]!.id, 'MIA question'),
      sendText(shops[0]!.id, buyers[1]!.id, 'Second buyer'),
      sendText(shops[1]!.id, buyers[0]!.id, 'Pixel question'),
    ]);

    const mia = await conversations(shops[0]!.id);
    const pixel = await conversations(shops[1]!.id);
    expect(mia).toHaveLength(2);
    expect(pixel).toHaveLength(1);
    expect(mia.every((conversation: { shopId: string }) => conversation.shopId === shops[0]!.id)).toBe(true);
    expect(pixel[0].lastMessage.content.text).toBe('Pixel question');
  });

  it('persists edit/recall state and increments contextVersion', async () => {
    await sendText(shops[0]!.id, buyers[3]!.id, 'original');
    let snapshot = await onlyConversation(shops[0]!.id, buyers[3]!.id);
    const messageId = snapshot.messages[0].id;
    const initialContextVersion = snapshot.contextVersion;

    await request(app.getHttpServer())
      .patch(`/api/buyer/messages/${messageId}`)
      .set('X-Demo-Workspace-Token', token)
      .send({ text: 'edited' })
      .expect(202);
    snapshot = await onlyConversation(shops[0]!.id, buyers[3]!.id);
    expect(snapshot.messages[0]).toMatchObject({ status: 'EDITED', content: { text: 'edited' } });

    await request(app.getHttpServer())
      .post(`/api/buyer/messages/${messageId}/recall`)
      .set('X-Demo-Workspace-Token', token)
      .expect(202);
    snapshot = await onlyConversation(shops[0]!.id, buyers[3]!.id);
    expect(snapshot.messages[0].status).toBe('RECALLED');
    expect(snapshot.contextVersion).toBe(initialContextVersion + 2);
  });

  it('normalizes product/order cards and rejects cross-Workspace references', async () => {
    const products = (
      await request(app.getHttpServer())
        .get(`/api/shops/${shops[0]!.id}/products`)
        .set('X-Demo-Workspace-Token', token)
        .expect(200)
    ).body;
    const orders = (
      await request(app.getHttpServer())
        .get(`/api/shops/${shops[0]!.id}/orders`)
        .query({ buyerId: buyers[0]!.id })
        .set('X-Demo-Workspace-Token', token)
        .expect(200)
    ).body;

    await request(app.getHttpServer())
      .post('/api/buyer/cards/product')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId: shops[0]!.id, buyerId: buyers[0]!.id, productId: products[0].id })
      .expect(202);
    await request(app.getHttpServer())
      .post('/api/buyer/cards/order')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId: shops[0]!.id, buyerId: buyers[0]!.id, orderId: orders[0].id })
      .expect(202);

    const snapshot = await onlyConversation(shops[0]!.id, buyers[0]!.id);
    expect(snapshot.messages.map((message: { kind: string }) => message.kind)).toEqual(['GOODS_CARD', 'ORDER_CARD']);
    expect(snapshot.currentProduct.id).toBe(products[0].id);
    expect(snapshot.currentOrder.id).toBe(orders[0].id);

    await request(app.getHttpServer())
      .post('/api/buyer/cards/product')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId: shops[0]!.id, buyerId: buyers[1]!.id, productId: products[0].id, forcedSequence: 10 })
      .expect(202);
    await request(app.getHttpServer())
      .post('/api/buyer/cards/product')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId: shops[0]!.id, buyerId: buyers[1]!.id, productId: products[1].id, forcedSequence: 11 })
      .expect(202);
    await request(app.getHttpServer())
      .post('/api/buyer/cards/product')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId: shops[0]!.id, buyerId: buyers[1]!.id, productId: products[2].id, forcedSequence: 9 })
      .expect(202);
    let lateCardSnapshot = await onlyConversation(shops[0]!.id, buyers[1]!.id);
    expect(lateCardSnapshot.currentProduct.id).toBe(products[1].id);
    const newestProductCard = lateCardSnapshot.messages.find(
      (message: { sequence: number }) => message.sequence === 11,
    );
    await request(app.getHttpServer())
      .post(`/api/buyer/messages/${newestProductCard.id}/recall`)
      .set('X-Demo-Workspace-Token', token)
      .expect(202);
    lateCardSnapshot = await onlyConversation(shops[0]!.id, buyers[1]!.id);
    expect(lateCardSnapshot.currentProduct.id).toBe(products[0].id);

    const secondSession = (await request(app.getHttpServer()).post('/api/demo/workspaces').expect(201)).body;
    const secondShops = (
      await request(app.getHttpServer())
        .get('/api/shops')
        .set('X-Demo-Workspace-Token', secondSession.token)
        .expect(200)
    ).body;
    const secondBuyers = (
      await request(app.getHttpServer())
        .get('/api/buyers')
        .set('X-Demo-Workspace-Token', secondSession.token)
        .expect(200)
    ).body;
    await request(app.getHttpServer())
      .post('/api/buyer/cards/product')
      .set('X-Demo-Workspace-Token', secondSession.token)
      .send({ shopId: secondShops[0].id, buyerId: secondBuyers[0].id, productId: products[0].id })
      .expect(404);
  });

  it('pushes a Workspace-scoped event and uses REST snapshot after reconnect', async () => {
    const socket = io(baseUrl, { path: '/ws', transports: ['websocket'], auth: { token } });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const received = new Promise<{ eventType: string; workspaceId: string }>((resolve) => {
      socket.once('workspace.event', resolve);
    });
    await sendText(shops[0]!.id, buyers[0]!.id, 'live one');
    expect(await received).toMatchObject({ eventType: 'MESSAGE_RECEIVED' });
    socket.disconnect();

    await sendText(shops[0]!.id, buyers[0]!.id, 'while disconnected');
    const snapshot = await onlyConversation(shops[0]!.id, buyers[0]!.id);
    expect(snapshot.messages.map((message: { content: { text?: string } }) => message.content.text)).toEqual([
      'live one',
      'while disconnected',
    ]);
  });

  async function sendText(
    shopId: string,
    buyerId: string,
    text: string,
    forcedSequence?: number,
    duplicateExternalMessageId?: string,
  ) {
    return request(app.getHttpServer())
      .post('/api/buyer/messages')
      .set('X-Demo-Workspace-Token', token)
      .send({ shopId, buyerId, kind: 'TEXT', text, forcedSequence, duplicateExternalMessageId })
      .expect(202);
  }

  async function conversations(shopId: string) {
    return (
      await request(app.getHttpServer())
        .get('/api/conversations')
        .query({ shopId })
        .set('X-Demo-Workspace-Token', token)
        .expect(200)
    ).body;
  }

  async function onlyConversation(shopId: string, buyerId?: string) {
    const list = await conversations(shopId);
    const conversation = buyerId ? list.find((item: { buyer: { id: string } }) => item.buyer.id === buyerId) : list[0];
    expect(conversation).toBeDefined();
    return (
      await request(app.getHttpServer())
        .get(`/api/conversations/${conversation.id}`)
        .set('X-Demo-Workspace-Token', token)
        .expect(200)
    ).body;
  }
});
