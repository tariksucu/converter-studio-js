// What the tests share: a client on the fake API, a fake clock and temporary folders.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach } from 'node:test';
import { clock } from '../src/clock.ts';
import { ConverterStudio, type ClientOptions } from '../src/index.ts';
import { BASE, FakeAPI, KEY } from './fake-api.ts';

export interface FakeClock {
  now: number;
  readonly slept: number[];
}

const REAL = { now: clock.now, sleep: clock.sleep };

/** The real clock again after each test. */
export function restoreClock(): void {
  clock.now = REAL.now;
  clock.sleep = REAL.sleep;
}
afterEach(restoreClock);

/** Makes waiting instant: `sleep` only moves the clock, and records how long it was asked for. */
export function fakeClock(): FakeClock {
  const state: FakeClock = { now: 0, slept: [] };
  clock.now = () => state.now;
  clock.sleep = (ms, signal) => {
    signal?.throwIfAborted();
    state.slept.push(ms);
    state.now += ms;
    return Promise.resolve();
  };
  return state;
}

export function setup(options: ClientOptions = {}): {
  api: FakeAPI;
  client: ConverterStudio;
  time: FakeClock;
} {
  const api = new FakeAPI();
  const time = fakeClock();
  const client = new ConverterStudio({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch, ...options });
  return { api, client, time };
}

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/**
 * A new empty folder, deleted after the tests. Given by its real path: on macOS the temporary
 * folder is behind a symlink (/var is /private/var), and process.cwd() inside it gives the real
 * path, so a path built from the unresolved name would not match what the client saves to.
 */
export function tempDir(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'converter-studio-test-')));
  folders.push(folder);
  return folder;
}

export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
export const textOf = (value: Uint8Array): string => new TextDecoder().decode(value);
