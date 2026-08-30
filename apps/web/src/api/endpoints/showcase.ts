import type { MutationResult, ShowcaseCatalog } from '../types';
import { extractEntity, jsonHeaders, request, workspaceHeaders } from '../client';

export function getShowcaseCatalog(token: string): Promise<ShowcaseCatalog> {
  return request<ShowcaseCatalog>('/showcase/catalog', { headers: workspaceHeaders(token) });
}

export async function sendShowcaseDamageImage(
  token: string,
  input: { shopId: string; buyerId: string; conversationId?: string },
): Promise<MutationResult> {
  const png = decodeBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  const marker = new TextEncoder().encode('AICS_FIXTURE:DAMAGED_SLEEVE');
  const file = new File([png.buffer as ArrayBuffer, marker.buffer as ArrayBuffer], 'damaged-sleeve-fixture.png', { type: 'image/png' });
  const body = new FormData();
  body.append('shopId', input.shopId);
  body.append('buyerId', input.buyerId);
  if (input.conversationId) body.append('conversationId', input.conversationId);
  body.append('file', file);
  const uploaded = await request<unknown>('/attachments', {
    method: 'POST',
    headers: workspaceHeaders(token),
    body,
  }).then((payload) => extractEntity<{ id: string }>(payload, 'attachment'));
  return request<unknown>('/buyer/messages', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ ...input, kind: 'IMAGE', attachmentId: uploaded.id }),
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
