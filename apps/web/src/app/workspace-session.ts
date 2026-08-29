import type { DemoWorkspaceProfile } from '@ai-customer-service/contracts';

/**
 * The two browser sessions intentionally have different storage slots.
 *
 * Keep the old key out of this map. Existing users may still have a legacy
 * token stored there, but the re-architecture must never read, overwrite, or
 * clear it implicitly.
 */
export type WorkspaceSessionKind = 'operational' | 'scenario';

export type WorkspaceSessionRequest = Readonly<{
  kind: WorkspaceSessionKind;
  revision: number;
}>;

/**
 * Rejects late async work from the other browser session.
 *
 * A route switch is synchronous from React's point of view, but a previous
 * reset/bootstrap/socket callback can resume afterwards.  Only the currently
 * active session may start a request, and only its newest request may commit.
 */
export class WorkspaceSessionRequestGate {
  private revision = 0;

  constructor(private activeKind: WorkspaceSessionKind) {}

  activate(kind: WorkspaceSessionKind): void {
    if (!isWorkspaceSessionKind(kind) || kind === this.activeKind) return;
    this.activeKind = kind;
    this.revision += 1;
  }

  isActive(kind: WorkspaceSessionKind): boolean {
    return isWorkspaceSessionKind(kind) && this.activeKind === kind;
  }

  begin(kind: WorkspaceSessionKind): WorkspaceSessionRequest | null {
    if (!this.isActive(kind)) return null;
    this.revision += 1;
    return { kind, revision: this.revision };
  }

  isCurrent(request: WorkspaceSessionRequest): boolean {
    return Boolean(
      request
      && isWorkspaceSessionKind(request.kind)
      && this.activeKind === request.kind
      && this.revision === request.revision,
    );
  }
}

export const WORKSPACE_SESSION_STORAGE_KEYS: Readonly<Record<WorkspaceSessionKind, string>> = {
  operational: 'aikefu_operational_workspace_token_v2',
  scenario: 'aikefu_scenario_workspace_token',
};

export const LEGACY_WORKSPACE_TOKEN_STORAGE_KEY = 'ai-customer-service-demo.workspace-token';

// localStorage is only a persistence optimization. Privacy mode and embedded
// browsers may reject access at runtime, so keep the current page session
// usable without ever falling back to the legacy/shared token slot.
const inMemorySessionTokens: Partial<Record<WorkspaceSessionKind, string>> = {};

export const WORKSPACE_SESSION_PROFILES: Readonly<Record<WorkspaceSessionKind, DemoWorkspaceProfile>> = {
  operational: 'EMPTY',
  scenario: 'SEEDED',
};

/** Resetting a session follows the same data-isolation profile as creating it. */
export const WORKSPACE_SESSION_RESET_PROFILES: Readonly<Record<WorkspaceSessionKind, DemoWorkspaceProfile>> = {
  operational: 'EMPTY',
  scenario: 'SEEDED',
};

function isWorkspaceSessionKind(value: unknown): value is WorkspaceSessionKind {
  return value === 'operational' || value === 'scenario';
}

/** Returns null for an invalid runtime value instead of indexing to undefined. */
export function workspaceSessionStorageKey(kind: WorkspaceSessionKind): string | null {
  return isWorkspaceSessionKind(kind) ? WORKSPACE_SESSION_STORAGE_KEYS[kind] : null;
}

export function workspaceSessionProfile(kind: WorkspaceSessionKind): DemoWorkspaceProfile | null {
  return isWorkspaceSessionKind(kind) ? WORKSPACE_SESSION_PROFILES[kind] : null;
}

export function workspaceSessionResetProfile(kind: WorkspaceSessionKind): DemoWorkspaceProfile | null {
  return isWorkspaceSessionKind(kind) ? WORKSPACE_SESSION_RESET_PROFILES[kind] : null;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    const storage = window.localStorage;
    if (!storage) return null;
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      return null;
    }
    return storage;
  } catch {
    // Privacy mode, blocked storage, and SecurityError all land here. The
    // in-memory page session remains usable without a persistent token.
    return null;
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token ? token : null;
}

/** Safely reads only the storage slot owned by the requested session kind. */
export function readWorkspaceSessionToken(kind: WorkspaceSessionKind): string | null {
  const key = workspaceSessionStorageKey(kind);
  if (!key || !isWorkspaceSessionKind(kind)) return null;
  const storage = browserStorage();

  if (storage) {
    try {
      const token = normalizeToken(storage.getItem(key));
      if (token) {
        inMemorySessionTokens[kind] = token;
        return token;
      }
    } catch {
      // Fall through to the current page's in-memory session.
    }
  }
  return inMemorySessionTokens[kind] ?? null;
}

/** Stores a non-empty token in memory and persists it when browser storage permits. */
export function storeWorkspaceSessionToken(kind: WorkspaceSessionKind, token: string): void {
  const key = workspaceSessionStorageKey(kind);
  const normalizedToken = normalizeToken(token);
  if (!key || !normalizedToken || !isWorkspaceSessionKind(kind)) return;
  inMemorySessionTokens[kind] = normalizedToken;
  const storage = browserStorage();
  if (!storage) return;

  try {
    storage.setItem(key, normalizedToken);
  } catch {
    // Browser storage is an optimization. Callers can continue with the
    // token they already hold in memory when persistence is unavailable.
  }
}

/** Safely clears only the requested session slot; the legacy slot is untouched. */
export function clearWorkspaceSessionToken(kind: WorkspaceSessionKind): void {
  const key = workspaceSessionStorageKey(kind);
  if (!key || !isWorkspaceSessionKind(kind)) return;
  delete inMemorySessionTokens[kind];
  const storage = browserStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // There is no recovery action when browser storage is unavailable.
  }
}
