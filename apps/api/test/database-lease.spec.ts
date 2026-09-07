import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { acquireDatabaseLease, hasActiveDatabaseLease, registerDatabaseLeaseUntilClose } from '../src/eval-v2/database-lease';
import { createFileOnlyRuntime, evalV2CliPreflightPasses } from '../src/eval-v2/eval-v2.cli';

const databaseUrl = 'postgresql://user:secret@localhost:5432/customer_service';

function temporaryLeaseDirectory(): string {
  const directory = join(tmpdir(), `database-lease-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function markerPath(directory: string): string {
  const key = createHash('sha256').update(databaseUrl).digest('hex');
  return join(directory, `${key}.json`);
}

describe('database lease', () => {
  it('claims exactly its database without storing the database URL and releases on close', () => {
    const directory = temporaryLeaseDirectory();
    try {
      const lease = acquireDatabaseLease(databaseUrl, { directory, pid: 4242, isPidAlive: (pid) => pid === 4242 });

      expect(hasActiveDatabaseLease(databaseUrl, { directory, isPidAlive: (pid) => pid === 4242 })).toBe(true);
      expect(readFileSync(markerPath(directory), 'utf8')).not.toContain(databaseUrl);

      lease.release();
      expect(existsSync(markerPath(directory))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows only one atomic claimant for the same live database', () => {
    const directory = temporaryLeaseDirectory();
    try {
      const options = { directory, isPidAlive: (pid: number) => pid === 4242 };
      const first = acquireDatabaseLease(databaseUrl, { ...options, pid: 4242 });

      expect(() => acquireDatabaseLease(databaseUrl, { ...options, pid: 4343 }))
        .toThrow('DATABASE_LEASE_ALREADY_ACTIVE');

      first.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores and replaces a marker whose PID is no longer alive', () => {
    const directory = temporaryLeaseDirectory();
    try {
      writeFileSync(markerPath(directory), JSON.stringify({ pid: 1111 }));

      expect(hasActiveDatabaseLease(databaseUrl, { directory, isPidAlive: () => false })).toBe(false);
      const lease = acquireDatabaseLease(databaseUrl, { directory, pid: 2222, isPidAlive: (pid) => pid === 2222 });
      expect(hasActiveDatabaseLease(databaseUrl, { directory, isPidAlive: (pid) => pid === 2222 })).toBe(true);
      expect(readFileSync(markerPath(directory), 'utf8')).toContain('2222');
      lease.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes an API lease when its listening server closes', () => {
    const directory = temporaryLeaseDirectory();
    try {
      const server = new EventEmitter();
      registerDatabaseLeaseUntilClose(databaseUrl, server, { directory, pid: 4242, isPidAlive: (pid) => pid === 4242 });
      expect(hasActiveDatabaseLease(databaseUrl, { directory, isPidAlive: (pid) => pid === 4242 })).toBe(true);

      server.emit('close');
      expect(hasActiveDatabaseLease(databaseUrl, { directory, isPidAlive: (pid) => pid === 4242 })).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preflight blocks only a live lease for its configured database', async () => {
    const directory = temporaryLeaseDirectory();
    const keys = ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT'] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const currentDatabase = databaseUrl;
    const otherDatabase = 'postgresql://user:other-secret@localhost:5432/other_database';
    try {
      process.env.DATABASE_URL = currentDatabase;
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.S3_ENDPOINT = 'http://localhost:9000';
      const options = { directory, isPidAlive: (pid: number) => pid === process.pid };
      const otherLease = acquireDatabaseLease(otherDatabase, { directory, pid: process.pid, isPidAlive: options.isPidAlive });
      const createRuntimeWithLeaseOptions = createFileOnlyRuntime as unknown as (repoRoot: string, config: typeof options) => ReturnType<typeof createFileOnlyRuntime>;
      expect(await evalV2CliPreflightPasses(['--offline-fixture'], createRuntimeWithLeaseOptions(resolve(__dirname, '../../..'), options))).toBe(true);
      otherLease.release();

      const currentLease = acquireDatabaseLease(currentDatabase, { directory, pid: process.pid, isPidAlive: options.isPidAlive });
      expect(await evalV2CliPreflightPasses(['--offline-fixture'], createRuntimeWithLeaseOptions(resolve(__dirname, '../../..'), options))).toBe(false);
      currentLease.release();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
