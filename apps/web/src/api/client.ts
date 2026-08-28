/** Shared transport, workspace scoping, and response shape helpers. */

export const DEMO_TOKEN_STORAGE_KEY = 'ai-customer-service-demo.workspace-token';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
function endpoint(path: string): string {
  return `${apiBaseUrl}${path}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    return undefined;
  }

  return response.json();
}

export async function request<T>(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<T> {
  let response: Response;

  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('无法连接 Foundation API，请确认本地 API 已启动。', 0, 'NETWORK_ERROR');
  }

  const body = await parseResponse(response);

  if (!response.ok) {
    const errorPayload = body as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      errorPayload?.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      errorPayload?.error?.code,
    );
  }

  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new ApiError(`请求返回了非预期状态（${response.status}）。`, response.status, 'HTTP_STATUS_UNEXPECTED');
  }

  return body as T;
}

export function workspaceHeaders(token: string): HeadersInit {
  return {
    'X-Demo-Workspace-Token': token,
  };
}

export function jsonHeaders(token: string): HeadersInit {
  return {
    ...workspaceHeaders(token),
    'Content-Type': 'application/json',
  };
}

/** Accept both a bare array and the common `{ data/items/<resource>: [] }` snapshots. */
export function extractCollection<T>(payload: unknown, resourceKey: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  const direct = record[resourceKey] ?? record.items;
  if (Array.isArray(direct)) return direct as T[];
  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    if (Array.isArray(nested[resourceKey])) return nested[resourceKey] as T[];
    if (Array.isArray(nested.items)) return nested.items as T[];
  }
  if (Array.isArray(record.data)) return record.data as T[];
  return [];
}

export function extractEntity<T>(payload: unknown, resourceKey: string): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record[resourceKey] && typeof record[resourceKey] === 'object') {
      return record[resourceKey] as T;
    }
    if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
      const data = record.data as Record<string, unknown>;
      if (data[resourceKey] && typeof data[resourceKey] === 'object') return data[resourceKey] as T;
      return record.data as T;
    }
  }
  return payload as T;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'body', 'message', 'value']) {
    const text = stringValue(record[key]);
    if (text) return text;
  }
  return undefined;
}

/** Render a message regardless of whether the API exposes contentJson or a flattened content field. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  const direct = readTextValue(record.text);
  if (direct) return direct;
  const content = typeof record.content === 'string' ? record.content : readTextValue(record.content);
  if (content) return content;
  const contentJson = record.contentJson;
  if (typeof contentJson === 'string') {
    try {
      return readTextValue(JSON.parse(contentJson)) ?? contentJson;
    } catch {
      return contentJson;
    }
  }
  const jsonText = readTextValue(contentJson);
  if (jsonText) return jsonText;
  return '';
}
