/**
 * Files to upload and results to save: what can be converted, how it becomes a `Blob` that can
 * be read from any offset (so a part can be sent again), and where a result is written.
 *
 * @module
 */

import { requireServerFiles, serverFiles, type FileHandle, type ServerFiles } from './runtime.ts';

/**
 * What can be converted:
 *
 * - a path (`string`, or a `file:` `URL`) in Node.js, Deno and Bun;
 * - a link: a `string` or `URL` starting with `http://` or `https://`, which Converter Studio
 *   fetches itself (only {@linkcode ConverterStudio.convert} takes links);
 * - a `Blob` or a `File`;
 * - bytes: a `Uint8Array` (a Node.js `Buffer` is one), another typed array or an `ArrayBuffer`;
 * - a `ReadableStream` of bytes, or any async iterable of `Uint8Array` (a Node.js `Readable`).
 *
 * Bytes, a `Blob` that is not a `File` and streams need a `fileName`.
 */
export type Source =
  | string
  | URL
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** A stream is kept in memory up to this size, then in a temporary file (where there is one). */
export const SPOOL_BYTES: number = 8 * 1024 * 1024;

/** A file to upload, readable from any offset, and what to do once it has been sent. */
export interface FileSource {
  readonly name: string;
  readonly size: number;
  /** At most this many bytes a part, when parts are read into memory; `null`: no limit. */
  readonly maxPart: number | null;
  /** One part's bytes, read again for each attempt (so a part can be sent again). */
  part(offset: number, length: number): Promise<Blob | Uint8Array<ArrayBuffer>>;
  cleanup(): Promise<void>;
}

/**
 * How files on disk are read. Node.js and Bun give a `Blob` that reads the file only as it is
 * sent (`fs.openAsBlob`); Deno's reads the whole file into memory (measured: 1 GB at the peak for
 * a 400 MB file), so there each part is read from the file when it is sent, 16 MiB at most.
 */
export const fileReading: { lazyBlobs: boolean; readPartBytes: number } = {
  lazyBlobs: !('Deno' in globalThis),
  readPartBytes: 16 * 1024 * 1024,
};

/** Whether `source` is a link Converter Studio fetches itself. */
export function isLink(source: unknown): source is string | URL {
  if (typeof source === 'string') return /^https?:\/\//i.test(source);
  return source instanceof URL && (source.protocol === 'http:' || source.protocol === 'https:');
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReadableStream).getReader === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

const nothing = (): Promise<void> => Promise.resolve();

function blobSource(name: string, blob: Blob, cleanup = nothing): FileSource {
  return {
    name,
    size: blob.size,
    maxPart: null,
    part: (offset, length) => Promise.resolve(blob.slice(offset, offset + length)),
    cleanup,
  };
}

/** A file on disk, read as it is sent (see {@linkcode fileReading}). */
async function pathSource(
  files: ServerFiles,
  path: string,
  name: string,
  cleanup = nothing,
): Promise<FileSource> {
  const stat = await files.fs.promises.stat(path);
  if (!stat.isFile()) throw new TypeError(`Not a file: ${path}`);
  if (fileReading.lazyBlobs) return blobSource(name, await files.fs.openAsBlob(path), cleanup);
  const handle = await files.fs.promises.open(path, 'r');
  return {
    name,
    size: stat.size,
    maxPart: fileReading.readPartBytes,
    part: async (offset, length) => {
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
        if (bytesRead === 0) throw new Error('The file got shorter while it was being sent');
        read += bytesRead;
      }
      return bytes;
    },
    cleanup: async () => {
      await handle.close();
      await cleanup();
    },
  };
}

function needName(what: string): TypeError {
  return new TypeError(`fileName is needed with ${what} (for example 'photo.heic')`);
}

/** The local path a `string` or a `file:` `URL` names. */
export function localPath(source: string | URL, files: ServerFiles): string {
  if (typeof source === 'string') return source;
  if (source.protocol !== 'file:')
    throw new TypeError(`Only file: and http(s): links can be converted, not ${source.protocol}`);
  return files.fileURLToPath(source);
}

/** What to upload, with its name (the API reads the format from the bytes and the name). */
export async function fileSource(
  source: Source,
  fileName: string | undefined,
  signal?: AbortSignal,
): Promise<FileSource> {
  if (typeof source === 'string' || source instanceof URL) {
    const files = requireServerFiles();
    const path = localPath(source, files);
    return pathSource(files, path, fileName || files.path.basename(path));
  }
  if (source instanceof Blob) {
    const own = (source as Partial<File>).name;
    const name = fileName || (typeof own === 'string' ? own : '');
    if (!name) throw needName('a Blob');
    return blobSource(name, source);
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    if (!fileName) throw needName('bytes');
    const bytes =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return blobSource(fileName, new Blob([bytes as Uint8Array<ArrayBuffer>]));
  }
  if (isReadableStream(source) || isAsyncIterable(source)) {
    // A Node.js file stream knows its path.
    const ownPath = (source as { path?: unknown }).path;
    const files = serverFiles();
    const name =
      fileName || (typeof ownPath === 'string' && files ? files.path.basename(ownPath) : '');
    if (!name) throw needName('a stream');
    const chunks = isReadableStream(source) ? readChunks(source) : source;
    return spool(name, chunks, signal);
  }
  throw new TypeError(
    'Cannot convert this: pass a path, a link, a Blob or File, bytes or a stream of bytes',
  );
}

async function* readChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Writes all of `chunk` (a file handle may write less than asked). */
export async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    offset += bytesWritten;
  }
}

/**
 * A stream read to the end into something that can be read again from any offset: memory for
 * a small one, a temporary file for a larger one (Node.js, Deno, Bun), or a `Blob` (browsers).
 */
async function spool(
  name: string,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<FileSource> {
  const files = serverFiles();
  // Bytes not yet written anywhere, and (in a browser) the blobs made of earlier ones.
  const memory: Uint8Array<ArrayBuffer>[] = [];
  const blobs: Blob[] = [];
  let held = 0;
  let dir: string | null = null;
  let path = '';
  let handle: FileHandle | null = null;
  const removeDir = async (): Promise<void> => {
    if (dir && files) await files.fs.promises.rm(dir, { recursive: true, force: true });
  };
  try {
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array))
        throw new TypeError('A stream to convert must give bytes (Uint8Array), not text');
      if (handle) {
        await writeAll(handle, chunk);
        continue;
      }
      memory.push(new Uint8Array(chunk));
      held += chunk.byteLength;
      if (held <= SPOOL_BYTES) continue;
      if (files) {
        dir = await files.fs.promises.mkdtemp(files.path.join(files.tmpdir(), 'converter-studio-'));
        path = files.path.join(dir, 'upload');
        handle = await files.fs.promises.open(path, 'wx');
        for (const part of memory.splice(0)) await writeAll(handle, part);
      } else {
        // A browser keeps large blobs on disk itself.
        blobs.push(new Blob(memory.splice(0)));
        held = 0;
      }
    }
    if (handle && files) {
      await handle.close();
      handle = null;
      return await pathSource(files, path, name, removeDir);
    }
    return blobSource(name, new Blob([...blobs, ...memory]));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeDir().catch(() => undefined);
    throw error;
  }
}

/** `(offset, length)` of each part; one empty part for an empty file. */
export function partRanges(size: number, partBytes: number): [number, number][] {
  if (size <= partBytes) return [[0, size]];
  const ranges: [number, number][] = [];
  for (let offset = 0; offset < size; offset += partBytes)
    ranges.push([offset, Math.min(partBytes, size - offset)]);
  return ranges;
}

// eslint-disable-next-line no-control-regex -- control characters are what it replaces
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\]/g;

/** A name to save a result under: its last part only, without control characters. */
export function safeFileName(name: string | null, fallback: string): string {
  const last = (name ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = last
    .replace(UNSAFE_NAME, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return clean || fallback;
}

async function exists(files: ServerFiles, path: string): Promise<boolean> {
  try {
    await files.fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `path`, or with `-1`, `-2`... before its extension when a file is already there. */
export async function freePath(files: ServerFiles, path: string): Promise<string> {
  if (!(await exists(files, path))) return path;
  const dir = files.path.dirname(path);
  const name = files.path.basename(path);
  const dot = name.toLowerCase().endsWith('.tar.gz') ? name.length - 7 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 10_000; n++) {
    const candidate = files.path.join(dir, `${stem}-${n}${suffix}`);
    if (!(await exists(files, candidate))) return candidate;
  }
  throw new Error(`No free name for ${path}`);
}

/**
 * Where a result goes: into a folder (the current one when none is given, one that exists, or a
 * path ending in a slash) under its own name, or to the exact path given.
 */
export async function targetPath(
  files: ServerFiles,
  destination: string | URL | undefined,
  outputName: string,
): Promise<{ path: string; exact: boolean }> {
  if (destination === undefined)
    return { path: files.path.join(files.cwd(), outputName), exact: false };
  const given = localPath(destination, files);
  const isDir =
    given.endsWith('/') ||
    given.endsWith(files.path.sep) ||
    (await files.fs.promises.stat(given).then(
      (stat) => stat.isDirectory(),
      () => false,
    ));
  return isDir
    ? { path: files.path.join(given, outputName), exact: false }
    : { path: given, exact: true };
}

/** A temporary name next to `path`, renamed to it once the file is complete. */
export function temporaryPath(files: ServerFiles, path: string): string {
  const tag = crypto.randomUUID().slice(0, 8);
  return files.path.join(files.path.dirname(path), `.${files.path.basename(path)}.${tag}.part`);
}

/** An error like the ones `node:fs` throws for a file that is already there. */
export function existsError(path: string): Error {
  return Object.assign(new Error(`${path} exists; pass overwrite: true to replace it`), {
    code: 'EEXIST',
    path,
  });
}
