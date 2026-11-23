/**
 * What the package needs from the JavaScript runtime beyond `fetch`: environment variables, the
 * file system (Node.js, Deno and Bun, through `process.getBuiltinModule`, so that nothing imports
 * `node:fs` and the package stays loadable in a browser), and whether it runs in a web page.
 *
 * @module
 */

import { ConverterStudioError } from './errors.ts';

/** The parts of `node:fs/promises`' file handle the package uses. */
export interface FileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesWritten: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The parts of `node:fs` the package uses. */
export interface NodeFs {
  openAsBlob(path: string): Promise<Blob>;
  promises: {
    open(path: string, flags: string): Promise<FileHandle>;
    stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    mkdtemp(prefix: string): Promise<string>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  };
}

/** The parts of `node:path` the package uses. */
export interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
  readonly sep: string;
}

/** The file system of a server runtime. */
export interface ServerFiles {
  readonly fs: NodeFs;
  readonly path: NodePath;
  readonly tmpdir: () => string;
  readonly cwd: () => string;
  readonly fileURLToPath: (url: URL) => string;
}

interface ProcessLike {
  env?: Record<string, string | undefined>;
  versions?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
  cwd?: () => string;
}

function runtimeProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

/** An environment variable, or `undefined` (also where reading it is not allowed, as in Deno). */
export function env(name: string): string | undefined {
  try {
    const value = runtimeProcess()?.env?.[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the code runs in a web page or a web worker (not in Node.js, Deno or Bun, which have
 * `process.versions.node`).
 */
export function isBrowser(): boolean {
  if (runtimeProcess()?.versions?.['node']) return false;
  const scope = globalThis as { document?: unknown; importScripts?: unknown };
  return typeof scope.document === 'object' || typeof scope.importScripts === 'function';
}

/** `node/24.22.3`, `deno/2.9.8`, `bun/1.4.5`, or `unknown`. */
export function runtimeName(): string {
  const versions = runtimeProcess()?.versions ?? {};
  for (const name of ['bun', 'deno', 'node']) {
    const version = versions[name];
    if (version) return `${name}/${version}`;
  }
  return 'unknown';
}

let files: ServerFiles | null | undefined;

/** The file system, or `null` in a browser. */
export function serverFiles(): ServerFiles | null {
  if (files !== undefined) return files;
  const proc = runtimeProcess();
  let found: ServerFiles | null = null;
  try {
    const fs = proc?.getBuiltinModule?.('node:fs') as NodeFs | undefined;
    const path = proc?.getBuiltinModule?.('node:path') as NodePath | undefined;
    const os = proc?.getBuiltinModule?.('node:os') as { tmpdir(): string } | undefined;
    const url = proc?.getBuiltinModule?.('node:url') as
      { fileURLToPath(url: URL): string } | undefined;
    if (fs?.openAsBlob && path && os && url && proc?.cwd) {
      const cwd = proc.cwd.bind(proc);
      found = {
        fs,
        path,
        tmpdir: () => os.tmpdir(),
        cwd,
        fileURLToPath: (link) => url.fileURLToPath(link),
      };
    }
  } catch {
    found = null;
  }
  files = found;
  return found;
}

/** The file system, or an error that says where paths work. */
export function requireServerFiles(): ServerFiles {
  const found = serverFiles();
  if (!found)
    throw new ConverterStudioError(
      'File paths work in Node.js (22.12 or later), Deno and Bun. In a browser, pass a File or a Blob.',
    );
  return found;
}
