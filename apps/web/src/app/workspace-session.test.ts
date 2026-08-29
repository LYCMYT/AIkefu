import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkspaceSessionToken,
  LEGACY_WORKSPACE_TOKEN_STORAGE_KEY,
  readWorkspaceSessionToken,
  storeWorkspaceSessionToken,
  workspaceSessionProfile,
  workspaceSessionResetProfile,
  workspaceSessionStorageKey,
  WorkspaceSessionRequestGate,
  WORKSPACE_SESSION_STORAGE_KEYS,
  type WorkspaceSessionKind,
} from './workspace-session';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
}

afterEach(() => {
  clearWorkspaceSessionToken('operational');
  clearWorkspaceSessionToken('scenario');
  vi.unstubAllGlobals();
});

describe('isolated Workspace browser sessions', () => {
  it('maps operational and scenario sessions to separate keys and profiles', () => {
    expect(WORKSPACE_SESSION_STORAGE_KEYS.operational).toBe('aikefu_operational_workspace_token_v2');
    expect(WORKSPACE_SESSION_STORAGE_KEYS.scenario).toBe('aikefu_scenario_workspace_token');
    expect(workspaceSessionStorageKey('operational')).toBe('aikefu_operational_workspace_token_v2');
    expect(workspaceSessionStorageKey('scenario')).toBe('aikefu_scenario_workspace_token');
    expect(workspaceSessionProfile('operational')).toBe('EMPTY');
    expect(workspaceSessionProfile('scenario')).toBe('SEEDED');
    expect(workspaceSessionResetProfile('operational')).toBe('EMPTY');
    expect(workspaceSessionResetProfile('scenario')).toBe('SEEDED');
  });

  it('keeps reads, writes, and clears isolated while preserving the legacy token', () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY, 'legacy-token');
    vi.stubGlobal('window', { localStorage: storage });

    expect(readWorkspaceSessionToken('operational')).toBeNull();
    expect(readWorkspaceSessionToken('scenario')).toBeNull();

    storeWorkspaceSessionToken('operational', ' operational-token ');
    storeWorkspaceSessionToken('scenario', 'scenario-token');

    expect(readWorkspaceSessionToken('operational')).toBe('operational-token');
    expect(readWorkspaceSessionToken('scenario')).toBe('scenario-token');
    expect(storage.getItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY)).toBe('legacy-token');

    clearWorkspaceSessionToken('operational');
    expect(readWorkspaceSessionToken('operational')).toBeNull();
    expect(readWorkspaceSessionToken('scenario')).toBe('scenario-token');
    expect(storage.getItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY)).toBe('legacy-token');

    clearWorkspaceSessionToken('scenario');
    expect(storage.getItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY)).toBe('legacy-token');
  });

  it('ignores empty or invalid runtime inputs without touching existing data', () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY, 'legacy-token');
    vi.stubGlobal('window', { localStorage: storage });

    storeWorkspaceSessionToken('operational', '   ');
    storeWorkspaceSessionToken('operational', 42 as unknown as string);
    expect(readWorkspaceSessionToken('operational')).toBeNull();

    const invalidKind = 'other' as WorkspaceSessionKind;
    expect(workspaceSessionStorageKey(invalidKind)).toBeNull();
    expect(workspaceSessionProfile(invalidKind)).toBeNull();
    expect(workspaceSessionResetProfile(invalidKind)).toBeNull();
    expect(() => readWorkspaceSessionToken(invalidKind)).not.toThrow();
    expect(() => storeWorkspaceSessionToken(invalidKind, 'invalid-token')).not.toThrow();
    expect(() => clearWorkspaceSessionToken(invalidKind)).not.toThrow();
    expect(storage.getItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY)).toBe('legacy-token');
  });

  it('keeps the current page session usable when window storage is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(readWorkspaceSessionToken('operational')).toBeNull();
    storeWorkspaceSessionToken('operational', 'memory-operational');
    expect(readWorkspaceSessionToken('operational')).toBe('memory-operational');
    clearWorkspaceSessionToken('operational');
    expect(readWorkspaceSessionToken('operational')).toBeNull();

    const blockedWindow = {};
    Object.defineProperty(blockedWindow, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage blocked');
      },
    });
    vi.stubGlobal('window', blockedWindow);
    expect(readWorkspaceSessionToken('scenario')).toBeNull();
    storeWorkspaceSessionToken('scenario', 'memory-scenario');
    expect(readWorkspaceSessionToken('scenario')).toBe('memory-scenario');
    clearWorkspaceSessionToken('scenario');
    expect(readWorkspaceSessionToken('scenario')).toBeNull();
  });

  it('does not fall back to the legacy storage key', () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_WORKSPACE_TOKEN_STORAGE_KEY, 'legacy-only-token');
    vi.stubGlobal('window', { localStorage: storage });

    expect(readWorkspaceSessionToken('operational')).toBeNull();
    expect(readWorkspaceSessionToken('scenario')).toBeNull();
  });

  it('rejects a late operational request after navigation activates the scenario session', () => {
    const gate = new WorkspaceSessionRequestGate('operational');
    const operationalRequest = gate.begin('operational');
    expect(operationalRequest).not.toBeNull();

    // This models a route change while an operational reset/refresh awaits.
    // Its old closure must not be able to start or commit an operational load
    // after the scenario session became active.
    gate.activate('scenario');
    const scenarioRequest = gate.begin('scenario');

    expect(gate.isCurrent(operationalRequest!)).toBe(false);
    expect(gate.begin('operational')).toBeNull();
    expect(gate.isCurrent(scenarioRequest!)).toBe(true);
  });
});
