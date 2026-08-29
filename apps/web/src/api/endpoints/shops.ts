import type { ShopSummary } from '../types';
import { extractEntity, jsonHeaders, request } from '../client';

export interface CreateShopInput {
  platform: 'DOUYIN_DEMO';
  templateKey: string;
  name?: string;
  aiMode?: ShopAiMode;
}

export type ShopAiMode = ShopSummary['aiMode'];

/** Create a demo shop from a server-owned seed template. */
export function createShop(token: string, input: CreateShopInput): Promise<ShopSummary> {
  return request<unknown>('/shops', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }).then((payload) => extractEntity<ShopSummary>(payload, 'shop'));
}

/** Change the shop policy ceiling used by conversation AUTO/ASSIST controls. */
export function updateShopAiMode(token: string, shopId: string, mode: ShopAiMode): Promise<ShopSummary> {
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/ai-mode`, {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify({ mode }),
  }).then((payload) => extractEntity<ShopSummary>(payload, 'shop'));
}

export function getShopSettings(token: string, shopId: string): Promise<import('../types').ShopSettings> {
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/settings`, {
    headers: { 'X-Demo-Workspace-Token': token },
  }).then((payload) => extractEntity<import('../types').ShopSettings>(payload, 'settings'));
}

export function updateShopSettings(token: string, shopId: string, input: import('../types').ShopSettingsInput): Promise<import('../types').ShopSettings> {
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/settings`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }).then((payload) => extractEntity<import('../types').ShopSettings>(payload, 'settings'));
}
