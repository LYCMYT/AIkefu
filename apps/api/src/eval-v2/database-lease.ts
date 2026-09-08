import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type DatabaseLeaseOptions = {
  directory?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
};

export type DatabaseLease = { release(): void };

type CloseEmitter = { once(event: 'close', listener: () => void): unknown };

type LeaseMarker = { pid: number; owner: string };

const defaultDirectory = () => join(tmpdir(), 'ai-customer-service', 'database-leases');

/** A local, non-secret marker that identifies a DATABASE_URL by its SHA-256 digest. */
export function acquireDatabaseLease(databaseUrl: string, options: DatabaseLeaseOptions = {}): DatabaseLease {
  const directory = options.directory ?? defaultDirectory();
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? processIsAlive;
  const path = leasePath(databaseUrl, directory);
  const owner = randomUUID();
  mkdirSync(directory, { recursive: true });

  while (true) {
    try {
      const descriptor = openSync(path, 'wx');
      try {
        writeFileSync(descriptor, JSON.stringify({ pid, owner } satisfies LeaseMarker));
      } finally {
        closeSync(descriptor);
      }
      return { release: () => releaseLease(path, owner) };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const marker = readMarker(path);
      if (marker && isPidAlive(marker.pid)) throw new Error('DATABASE_LEASE_ALREADY_ACTIVE');
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

/** Claims the database for the lifetime of a local API server. */
export function registerDatabaseLeaseUntilClose(
  databaseUrl: string,
  server: CloseEmitter,
  options: DatabaseLeaseOptions = {},
): DatabaseLease {
  const lease = acquireDatabaseLease(databaseUrl, options);
  server.once('close', lease.release);
  return lease;
}

/** Returns true only for a live process claiming this exact DATABASE_URL digest. */
export function hasActiveDatabaseLease(databaseUrl: string, options: DatabaseLeaseOptions = {}): boolean {
  const path = leasePath(databaseUrl, options.directory ?? defaultDirectory());
  const marker = readMarker(path);
  if (!marker) return false;
  if ((options.isPidAlive ?? processIsAlive)(marker.pid)) return true;
  if (existsSync(path)) unlinkSync(path);
  return false;
}

function leasePath(databaseUrl: string, directory: string): string {
  return join(directory, `${createHash('sha256').update(databaseUrl).digest('hex')}.json`);
}

function readMarker(path: string): LeaseMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseMarker>;
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && typeof value.owner === 'string'
      ? { pid: value.pid, owner: value.owner }
      : undefined;
  } catch { return undefined; }
}

function releaseLease(path: string, owner: string): void {
  const marker = readMarker(path);
  if (marker?.owner === owner && existsSync(path)) unlinkSync(path);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}
