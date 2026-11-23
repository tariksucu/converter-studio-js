/**
 * The client: {@linkcode ConverterStudio}.
 *
 * @module
 */

import { clock } from './clock.ts';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConfirmationRequiredError,
  ConflictError,
  ConversionFailedError,
  ConversionTimeoutError,
  ConverterStudioError,
  FileTooLargeError,
  GoneError,
  InsufficientCreditsError,
  MissingApiKeyError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  UnprocessableError,
} from './errors.ts';
import {
  existsError,
  fileSource,
  freePath,
  isLink,
  partRanges,
  safeFileName,
  targetPath,
  temporaryPath,
  writeAll,
  type FileSource,
  type Source,
} from './files.ts';
import {
  FINISHED_STATUSES,
  SETTLED_STATUSES,
  asObject,
  params,
  toAccount,
  toConversion,
  toFormat,
  toUpload,
  type Account,
  type Conversion,
  type ConversionOptions,
  type Format,
  type Upload,
} from './models.ts';
import { env, isBrowser, requireServerFiles, runtimeName, type FileHandle } from './runtime.ts';
import { VERSION } from './version.ts';

/** The API's address unless another is given. */
export const DEFAULT_BASE_URL: string = 'https://converter.studio/api';
/** The environment variable the API key is read from. */
export const API_KEY_ENV: string = 'CONVERTER_STUDIO_API_KEY';
/** The environment variable another API address is read from. */
export const BASE_URL_ENV: string = 'CONVERTER_STUDIO_BASE_URL';

const CLIENT_HEADER = 'X-Converter-Studio-Client';
const CLIENT_NAME = 'node';
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT = 600_000;
/** The API holds a status request up to this many seconds until the conversion settles. */
const LONG_POLL_SECONDS = 25;
/** One request's body at most (the CDN in front of the API stops at 100 MB). */
const DEFAULT_PART_BYTES = 95 * 1024 * 1024;
/** A part upload gets one more second of its timeout for every this many bytes. */
const UPLOAD_BYTES_PER_SECOND = 32 * 1024;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

const BROWSER_KEY_MESSAGE =
  'An API key does not belong in a web page: anyone who opens the page can read it and spend ' +
  "the account's credits. Call Converter Studio from your server instead. If the key is the " +
  "page user's own (they typed it in themselves), pass dangerouslyAllowBrowser: true.";

// The site's English messages for the codes the download route sends without one.
const FALLBACK_MESSAGES: Readonly<Record<string, string>> = {
  fileExpired: 'This file has already been deleted. Please convert it again.',
  notFound: "We couldn't find that conversion.",
  tooManyRequests: "You're going a bit fast. Please wait a moment and try again.",
  serverBusy: 'Our servers are busy right now. Please try again in a few minutes.',
  invalidRequest: "Something about that request wasn't right.",
  invalidApiKey: 'This API key does not work. Create one on your account page at converter.studio.',
};

const ERRORS_BY_STATUS: Readonly<Record<number, typeof APIError>> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: InsufficientCreditsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  410: GoneError,
  413: FileTooLargeError,
  422: UnprocessableError,
};

/** A `fetch` function: the global one, or your own (a proxy, a test double). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The settings of a {@linkcode ConverterStudio} client. */
export interface ClientOptions {
  /**
   * The account's API key (`cvs_live_...`), from https://converter.studio/account#api-keys.
   * Default: the `CONVERTER_STUDIO_API_KEY` environment variable. Listing formats needs none.
   */
  apiKey?: string | undefined;
  /** The API's address. Default: `CONVERTER_STUDIO_BASE_URL`, or `https://converter.studio/api`. */
  baseUrl?: string | undefined;
  /** The `fetch` to send requests with. Default: the runtime's own. */
  fetch?: FetchLike | undefined;
  /**
   * How long one request may wait for an answer, in milliseconds (default 60 000). Uploads get
   * more for their size; a download may take as long as it needs while data keeps arriving.
   */
  timeout?: number | undefined;
  /**
   * How often a request is sent again after a network error, a timeout or a 408, 429 or 5xx
   * answer, with a growing pause (default 2). Conversions are created with an
   * `Idempotency-Key`, so a retry never starts or charges a second one.
   */
  maxRetries?: number | undefined;
  /**
   * In a web page, the client refuses an API key: anyone who opens the page could read it. Set
   * this only when the key is the page user's own (they typed it in themselves).
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

/** What every method takes. */
export interface RequestOptions {
  /** Stops the call (and its waiting and retries); it then rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
}

/** The settings of {@linkcode ConverterStudio.createConversion}. */
export interface CreateConversionParams extends RequestOptions {
  /** The format to convert to (`jpg`, `mp4`, `pdf`...). */
  to: string;
  /** A link to the file (a direct link, or a Google Drive, Dropbox or OneDrive share link). */
  url?: string | undefined;
  /** An upload whose file has arrived ({@linkcode ConverterStudio.upload}). */
  uploadId?: string | undefined;
  /** The conversion's settings (`{ quality: 'high' }`). */
  options?: ConversionOptions | undefined;
  /** It goes ahead on its own up to this price (the API's default is 20; 0 only prices it). */
  maxCredits?: number | undefined;
  /**
   * An `https://` address on the public internet that Converter Studio POSTs to when the
   * conversion waits for a go-ahead and when it ends (see {@linkcode parseCallback}).
   */
  callbackUrl?: string | undefined;
  /**
   * A repeat of the same request with the same key (within 24 hours) returns the first
   * conversion instead of starting and charging a second one. One is made up for each call
   * when not given, and kept for its retries; pass your own when your code may repeat a request.
   */
  idempotencyKey?: string | undefined;
}

/** The settings of {@linkcode ConverterStudio.upload}. */
export interface UploadOptions extends RequestOptions {
  /** The file's name; needed for bytes, streams and a `Blob` that is not a `File`. */
  fileName?: string | undefined;
  /** Makes the parts of a large upload smaller than the API's 95 MB, in bytes. */
  partSize?: number | undefined;
}

/** The settings of {@linkcode ConverterStudio.wait}. */
export interface WaitOptions extends RequestOptions {
  /** How long to wait, in milliseconds (default 600 000: 10 minutes). */
  timeout?: number | undefined;
}

/** The settings of {@linkcode ConverterStudio.convert}. */
export interface ConvertOptions extends UploadOptions {
  /** The conversion's settings (`{ quality: 'high' }`). */
  options?: ConversionOptions | undefined;
  /** It goes ahead on its own up to this price (the API's default is 20; 0 only prices it). */
  maxCredits?: number | undefined;
  /** See {@linkcode CreateConversionParams.callbackUrl}. */
  callbackUrl?: string | undefined;
  /** See {@linkcode CreateConversionParams.idempotencyKey}. */
  idempotencyKey?: string | undefined;
  /** `false` returns as soon as the conversion has started (default: wait until it is done). */
  wait?: boolean | undefined;
  /** How long to wait, in milliseconds (default 600 000: 10 minutes). */
  timeout?: number | undefined;
}

/** The settings of {@linkcode ConverterStudio.download}. */
export interface DownloadOptions extends RequestOptions {
  /** Replace a file that is already there (otherwise the result gets `-1`, `-2`...). */
  overwrite?: boolean | undefined;
}

interface Answer {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly text: string;
}

interface Call extends RequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly auth?: boolean | undefined;
  readonly timeout?: number | undefined;
}

function resolveBaseUrl(value: string | undefined): string {
  const url = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`baseUrl must be an http:// or https:// address, not ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new TypeError(`baseUrl must be an http:// or https:// address, not ${url}`);
  if (parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new TypeError('baseUrl must not hold a query, a fragment, a user name or a password');
  return url;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the server';
  }
}

/** A transport error in words, naming only the host (links carry tokens). */
function connectionError(error: unknown, url: string): APIConnectionError {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const reason =
    (typeof cause?.code === 'string' && cause.code) ||
    (typeof cause?.message === 'string' && cause.message) ||
    (error instanceof Error && error.message) ||
    String(error);
  return new APIConnectionError(`Could not reach ${host(url)}: ${reason}`, { cause: error });
}

/** `Retry-After` in seconds (a number or an HTTP date), when the answer has one. */
function retryAfterSeconds(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, (when - Date.now()) / 1000);
}

/**
 * Milliseconds before retry `attempt` (from 0): the server's `Retry-After` (at most a minute),
 * or an exponential back-off with jitter.
 */
function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter, 60) * 1000;
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base * (0.5 + Math.random() / 2);
}

function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * The API's error (`{"error": {"code", "message", "params"}}`; the download route's
 * `{"error": "code"}`), or a plain one for answers that did not come from the API.
 */
function errorFromAnswer(answer: Answer): APIError {
  let body: unknown;
  try {
    body = answer.text ? JSON.parse(answer.text) : undefined;
  } catch {
    body = undefined;
  }
  let code: string | null = null;
  let message: string | null = null;
  let values = {};
  const error = asObject(body)['error'];
  if (typeof error === 'string') {
    code = error;
    values = params(asObject(body)['params']);
  } else if (typeof error === 'object' && error !== null) {
    const object = asObject(error);
    code = typeof object['code'] === 'string' ? object['code'] : null;
    message = typeof object['message'] === 'string' ? object['message'] : null;
    values = params(object['params']);
  }
  message ??=
    FALLBACK_MESSAGES[code ?? ''] ??
    `The Converter Studio API answered ${answer.status} ${answer.statusText}`.trimEnd() + '.';
  const details = {
    status: answer.status,
    code,
    params: values,
    headers: lowerHeaders(answer.headers),
  };
  if (answer.status === 429)
    return new RateLimitError(message, {
      ...details,
      retryAfter: retryAfterSeconds(answer.headers),
    });
  const ErrorClass =
    ERRORS_BY_STATUS[answer.status] ?? (answer.status >= 500 ? ServerError : APIError);
  return new ErrorClass(message, details);
}

function json(answer: Answer): Readonly<Record<string, unknown>> {
  try {
    return asObject(JSON.parse(answer.text));
  } catch {
    return {};
  }
}

function conversionId(conversion: Conversion | string): string {
  const id = typeof conversion === 'string' ? conversion : conversion.id;
  if (!id) throw new TypeError('A conversion id is needed');
  return id;
}

function conversionPath(conversion: Conversion | string): string {
  return `/v1/conversions/${encodeURIComponent(conversionId(conversion))}`;
}

function newIdempotencyKey(): string {
  return `cvs-node-${crypto.randomUUID().replaceAll('-', '')}`;
}

/** `true` once the result is ready, `false` while it is on its way; throws when it ended
 * without one or waits for a go-ahead. */
function isSettled(conversion: Conversion): boolean {
  if (conversion.status === 'done') return true;
  if (FINISHED_STATUSES.has(conversion.status)) throw new ConversionFailedError(conversion);
  if (conversion.status === 'quoted') throw new ConfirmationRequiredError(conversion);
  return false;
}

function notReadyError(conversion: Conversion): ConverterStudioError {
  if (FINISHED_STATUSES.has(conversion.status)) return new ConversionFailedError(conversion);
  if (conversion.status === 'quoted') return new ConfirmationRequiredError(conversion);
  return new ConverterStudioError(
    `The conversion is not done yet (it is ${conversion.status}); wait for it first.`,
  );
}

/** A format's id as the API knows it (`.JPG` → `jpg`); also for callers without types. */
function formatName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/^\.+/, '') : '';
}

function checkDuration(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isFinite(value) && value > 0))
    throw new TypeError(`${name} must be a number of milliseconds above 0`);
}

/**
 * A client for the Converter Studio API (https://converter.studio/developers). It runs in
 * Node.js (22.12 or later), Deno, Bun and browsers, with the runtime's own `fetch`.
 *
 * @example
 * ```ts
 * import { ConverterStudio } from 'converter-studio';
 *
 * const client = new ConverterStudio(); // the key comes from CONVERTER_STUDIO_API_KEY
 * const conversion = await client.convert('IMG_1234.HEIC', 'jpg');
 * await client.download(conversion, 'photos/'); // photos/IMG_1234.jpg
 * ```
 */
export class ConverterStudio {
  /** The API's address. */
  readonly baseUrl: string;
  /** How long one request may wait for an answer, in milliseconds. */
  readonly timeout: number;
  /** How often a failed request is sent again. */
  readonly maxRetries: number;
  #apiKey: string | null;
  #fetch: FetchLike;

  /**
   * A client. In a web page, it refuses an API key unless `dangerouslyAllowBrowser` is set.
   *
   * @param options The API key, the API's address, `fetch`, timeouts and retries.
   */
  constructor(options: ClientOptions = {}) {
    const key = (options.apiKey ?? env(API_KEY_ENV) ?? '').trim();
    if (key && !/^[\x21-\x7e]+$/.test(key))
      throw new TypeError('The API key holds characters that cannot be sent in a request');
    if (key && isBrowser() && options.dangerouslyAllowBrowser !== true)
      throw new ConverterStudioError(BROWSER_KEY_MESSAGE);
    this.#apiKey = key || null;
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? env(BASE_URL_ENV));
    checkDuration('timeout', options.timeout);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const retries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(retries) || retries < 0)
      throw new TypeError('maxRetries must be a whole number, 0 or more');
    this.maxRetries = retries;
    const own = options.fetch;
    if (!own && typeof globalThis.fetch !== 'function')
      throw new ConverterStudioError(
        'This runtime has no fetch: use Node.js 22.12 or later, Deno, Bun or a browser, or pass fetch.',
      );
    this.#fetch = own ?? ((input, init) => globalThis.fetch(input, init));
  }

  // The API

  /**
   * The formats the API reads, and what each converts to right now (no key needed).
   *
   * @param options `from`: only that format.
   */
  async formats(options: RequestOptions & { from?: string | undefined } = {}): Promise<Format[]> {
    const from = options.from?.trim().toLowerCase().replace(/^\.+/, '');
    const answer = await this.#call({
      method: 'GET',
      path: '/v1/formats',
      query: from ? { from } : undefined,
      auth: this.#apiKey !== null,
      signal: options.signal,
    });
    const list = json(answer)['formats'];
    return Array.isArray(list) ? list.map(toFormat) : [];
  }

  /** The key's account: plan, credits left, limits. */
  async account(options: RequestOptions = {}): Promise<Account> {
    return toAccount(json(await this.#call({ method: 'GET', path: '/v1/account', ...options })));
  }

  /**
   * Opens an upload slot (`POST /v1/uploads`); {@linkcode ConverterStudio.upload} does this and
   * sends the file.
   *
   * @param fileName The file's name.
   * @param options `size`: the file's size in bytes (needed to send it in parts).
   */
  async createUpload(
    fileName: string,
    options: RequestOptions & { size?: number | undefined } = {},
  ): Promise<Upload> {
    const body: Record<string, unknown> = { fileName };
    if (options.size !== undefined) body['size'] = options.size;
    const answer = await this.#call({
      method: 'POST',
      path: '/v1/uploads',
      json: body,
      signal: options.signal,
    });
    return toUpload(json(answer));
  }

  /**
   * Sends a file and returns its upload; convert it with
   * {@linkcode ConverterStudio.createConversion} (`uploadId: upload.id`). Files larger than one
   * request carries (95 MB) go in parts, read from the file as they are sent.
   *
   * @param file A path, a `Blob` or `File`, bytes or a stream of bytes (see {@linkcode Source}).
   */
  async upload(file: Source, options: UploadOptions = {}): Promise<Upload> {
    const { signal } = options;
    if (
      options.partSize !== undefined &&
      !(Number.isInteger(options.partSize) && options.partSize > 0)
    )
      throw new TypeError('partSize must be a whole number of bytes above 0');
    const source = await fileSource(file, options.fileName, signal);
    try {
      const slot = await this.createUpload(source.name, { size: source.size, signal });
      const limit = slot.partBytes ?? DEFAULT_PART_BYTES;
      let partBytes = options.partSize ? Math.min(options.partSize, limit) : limit;
      if (source.maxPart !== null) partBytes = Math.min(partBytes, source.maxPart);
      const ranges = partRanges(source.size, partBytes);
      for (const [offset, length] of ranges)
        await this.#sendPart(slot, source, offset, length, ranges.length > 1, signal);
      return slot;
    } finally {
      await source.cleanup();
    }
  }

  /**
   * Starts converting a link's file (`url`) or an upload (`uploadId`), and returns at once;
   * see {@linkcode ConverterStudio.wait}.
   */
  async createConversion(params: CreateConversionParams): Promise<Conversion> {
    const to = formatName(params.to);
    if (!to) throw new TypeError('to (the format to convert to, such as "jpg") is needed');
    if ((params.url === undefined) === (params.uploadId === undefined))
      throw new TypeError('Give either url or uploadId');
    const body: Record<string, unknown> = { to };
    if (params.url !== undefined) body['url'] = params.url;
    if (params.uploadId !== undefined) body['uploadId'] = params.uploadId;
    if (params.options && Object.keys(params.options).length > 0) body['options'] = params.options;
    if (params.maxCredits !== undefined) {
      if (!Number.isInteger(params.maxCredits) || params.maxCredits < 0)
        throw new TypeError('maxCredits must be a whole number, 0 or more');
      body['maxCredits'] = params.maxCredits;
    }
    if (params.callbackUrl !== undefined) body['callbackUrl'] = params.callbackUrl;
    const key = params.idempotencyKey ?? newIdempotencyKey();
    if (!IDEMPOTENCY_KEY.test(key))
      throw new TypeError('idempotencyKey must be 1 to 255 visible ASCII characters');
    const answer = await this.#call({
      method: 'POST',
      path: '/v1/conversions',
      json: body,
      headers: { 'Idempotency-Key': key },
      signal: params.signal,
    });
    const replayed = answer.headers.get('idempotent-replayed')?.toLowerCase() === 'true';
    return toConversion(json(answer), replayed);
  }

  /**
   * A conversion's state now. With `waitSeconds` (1 to 60), the API holds the answer until the
   * conversion is done, failed or waits for a go-ahead, or the time is up.
   */
  async getConversion(
    conversion: Conversion | string,
    options: RequestOptions & { waitSeconds?: number | undefined } = {},
  ): Promise<Conversion> {
    const path = conversionPath(conversion);
    const wait = options.waitSeconds;
    if (!wait || wait <= 0)
      return toConversion(json(await this.#call({ method: 'GET', path, signal: options.signal })));
    const seconds = Math.max(1, Math.min(Math.floor(wait), 60));
    const answer = await this.#call({
      method: 'GET',
      path,
      query: { wait: String(seconds) },
      timeout: Math.max(this.timeout, (seconds + 30) * 1000),
      signal: options.signal,
    });
    return toConversion(json(answer));
  }

  /** Goes ahead with a conversion that costs more than its `maxCredits` (`quoted`). */
  async confirm(
    conversion: Conversion | string,
    options: RequestOptions = {},
  ): Promise<Conversion> {
    const answer = await this.#call({
      method: 'POST',
      path: `${conversionPath(conversion)}/confirm`,
      signal: options.signal,
    });
    return toConversion(json(answer));
  }

  // Waiting and results

  /**
   * Waits until the conversion is done and returns it. The API holds each status request until
   * something changes; answers that come back early are followed by a growing pause (1 second,
   * doubling up to 10).
   *
   * @throws {ConversionFailedError} when it fails, expires or is canceled
   * @throws {ConfirmationRequiredError} when it costs more than its `maxCredits`
   * @throws {ConversionTimeoutError} after `timeout` (it may still finish)
   */
  async wait(conversion: Conversion | string, options: WaitOptions = {}): Promise<Conversion> {
    const { signal } = options;
    checkDuration('timeout', options.timeout);
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT;
    const deadline = clock.now() + timeout;
    let current =
      typeof conversion === 'string'
        ? await this.getConversion(conversion, { signal })
        : conversion;
    let pause = 0;
    while (!isSettled(current)) {
      const remaining = deadline - clock.now();
      if (remaining <= 0)
        throw new ConversionTimeoutError(
          `The conversion did not finish within ${timeout / 1000} seconds (it is ` +
            `${current.status}). It may still finish: look it up later by its id, ${current.id}.`,
          current,
        );
      const seconds = Math.max(1, Math.min(LONG_POLL_SECONDS, Math.floor(remaining / 1000)));
      const started = clock.now();
      current = await this.getConversion(current.id, { waitSeconds: seconds, signal });
      if (SETTLED_STATUSES.has(current.status)) continue;
      if (clock.now() - started < seconds * 500) {
        pause = pause <= 0 ? 1000 : Math.min(pause * 2, 10_000);
        await clock.sleep(Math.min(pause, Math.max(0, deadline - clock.now())), signal);
      } else {
        pause = 0;
      }
    }
    return current;
  }

  /**
   * Converts a file to `to` and, unless `wait: false`, waits until it is done. Save the result
   * with {@linkcode ConverterStudio.download}.
   *
   * @param source A path, a link (`http://` or `https://`, fetched by Converter Studio itself),
   *   a `Blob` or `File`, bytes or a stream of bytes (see {@linkcode Source}).
   * @param to The format to convert to (`jpg`, `mp4`, `pdf`...).
   */
  async convert(source: Source, to: string, options: ConvertOptions = {}): Promise<Conversion> {
    const common = {
      to,
      options: options.options,
      maxCredits: options.maxCredits,
      callbackUrl: options.callbackUrl,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    };
    let created: Conversion;
    if (isLink(source)) {
      created = await this.createConversion({ ...common, url: String(source) });
    } else {
      const upload = await this.upload(source, options);
      created = await this.createConversion({ ...common, uploadId: upload.id });
    }
    if (options.wait === false) return created;
    return this.wait(created, { timeout: options.timeout, signal: options.signal });
  }

  /** The result's bytes as they arrive, as a stream (nothing is kept in memory). */
  async downloadStream(
    conversion: Conversion | string,
    options: RequestOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const done = await this.#ready(conversion, options.signal);
    return this.#openDownload(done.downloadUrl ?? '', options.signal);
  }

  /** The result, in memory. */
  async downloadBytes(
    conversion: Conversion | string,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    const reader = (await this.downloadStream(conversion, options)).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * Saves the result (Node.js, Deno, Bun) and returns where.
   *
   * @param destination A folder that exists or a path ending in `/` (the result keeps its name;
   *   the current folder when none is given), or a file path. In a folder, an existing file is
   *   never replaced unless `overwrite`: the result gets `-1`, `-2`... before its extension. An
   *   existing file path given exactly throws (`EEXIST`) unless `overwrite`. The file appears
   *   only once it is complete.
   */
  async download(
    conversion: Conversion | string,
    destination?: string | URL,
    options: DownloadOptions = {},
  ): Promise<string> {
    const { signal } = options;
    const files = requireServerFiles();
    const done = await this.#ready(conversion, signal);
    const name = safeFileName(done.outputName, `${done.id}.${done.to ?? 'bin'}`);
    const target = await targetPath(files, destination, name);
    let path = target.path;
    if (!options.overwrite) {
      if (target.exact) {
        const there = await files.fs.promises.stat(path).then(
          () => true,
          () => false,
        );
        if (there) throw existsError(path);
      } else {
        path = await freePath(files, path);
      }
    }
    await files.fs.promises.mkdir(files.path.dirname(path), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      const temporary = temporaryPath(files, path);
      let handle: FileHandle | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        reader = (await this.#openDownload(done.downloadUrl ?? '', signal)).getReader();
        handle = await files.fs.promises.open(temporary, 'wx');
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          await writeAll(handle, chunk.value);
        }
        await handle.close();
        handle = null;
        await files.fs.promises.rename(temporary, path);
        return path;
      } catch (error) {
        // A write that failed (a full disk) leaves the download open: stop it.
        await reader?.cancel().catch(() => undefined);
        await handle?.close().catch(() => undefined);
        await files.fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        if (!(error instanceof APIConnectionError) || attempt >= this.maxRetries) throw error;
        await clock.sleep(retryDelay(attempt, null), signal);
      }
    }
  }

  // Internals

  #clientHeaders(): Record<string, string> {
    const headers: Record<string, string> = { [CLIENT_HEADER]: `${CLIENT_NAME}/${VERSION}` };
    // Browsers set their own User-Agent.
    if (!isBrowser()) headers['User-Agent'] = `converter-studio-node/${VERSION} ${runtimeName()}`;
    return headers;
  }

  #requireKey(): string {
    if (this.#apiKey === null)
      throw new MissingApiKeyError(
        `No API key: pass apiKey or set ${API_KEY_ENV}. Create a key on your account page at ` +
          'https://converter.studio/account#api-keys.',
      );
    return this.#apiKey;
  }

  async #ready(
    conversion: Conversion | string,
    signal: AbortSignal | undefined,
  ): Promise<Conversion> {
    const current =
      typeof conversion === 'string'
        ? await this.getConversion(conversion, { signal })
        : conversion;
    if (current.status !== 'done' || !current.downloadUrl) throw notReadyError(current);
    return current;
  }

  /** One request and its answer read in full, within `timeout`; transport errors in words. */
  async #exchange(
    url: string,
    init: RequestInit,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<Answer> {
    const timer = new AbortController();
    const id = setTimeout(() => {
      timer.abort();
    }, timeout);
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        text: await response.text(),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timer.signal.aborted) throw new APITimeoutError(`The request to ${host(url)} timed out.`);
      throw connectionError(error, url);
    } finally {
      clearTimeout(id);
    }
  }

  /** An API request, sent again after network errors and 408, 429 and 5xx answers. */
  async #call(call: Call): Promise<Answer> {
    let url = `${this.baseUrl}${call.path}`;
    if (call.query) url += `?${new URLSearchParams(call.query).toString()}`;
    const headers: Record<string, string> = { ...this.#clientHeaders(), ...call.headers };
    if (call.auth !== false) headers['Authorization'] = `Bearer ${this.#requireKey()}`;
    const init: RequestInit = { method: call.method, headers, redirect: 'manual' };
    if (call.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(call.json);
    }
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.maxRetries;
      let answer: Answer;
      try {
        answer = await this.#exchange(url, init, call.timeout ?? this.timeout, call.signal);
      } catch (error) {
        if (last || !(error instanceof APIConnectionError)) throw error;
        await clock.sleep(retryDelay(attempt, null), call.signal);
        continue;
      }
      if (answer.status >= 200 && answer.status < 300) return answer;
      if (last || !RETRY_STATUSES.has(answer.status)) throw errorFromAnswer(answer);
      await clock.sleep(retryDelay(attempt, retryAfterSeconds(answer.headers)), call.signal);
    }
  }

  /** One part of an upload (`Upload-Offset` when the file goes in parts), with its retries. */
  async #sendPart(
    slot: Upload,
    source: FileSource,
    offset: number,
    length: number,
    inParts: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...this.#clientHeaders(),
      'Content-Type': 'application/octet-stream',
    };
    if (inParts) headers['Upload-Offset'] = String(offset);
    const timeout = this.timeout + Math.ceil(length / UPLOAD_BYTES_PER_SECOND) * 1000;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.maxRetries;
      let answer: Answer;
      try {
        const body = await source.part(offset, length);
        answer = await this.#exchange(
          slot.uploadUrl,
          { method: 'PUT', headers, body, redirect: 'manual' },
          timeout,
          signal,
        );
      } catch (error) {
        if (last || !(error instanceof APIConnectionError)) throw error;
        await clock.sleep(retryDelay(attempt, null), signal);
        continue;
      }
      if (answer.status >= 200 && answer.status < 300) return;
      const error = errorFromAnswer(answer);
      // The slot is gone once its last part is in: an earlier attempt got there.
      if (attempt > 0 && error instanceof NotFoundError) return;
      if (last || !RETRY_STATUSES.has(answer.status)) throw error;
      await clock.sleep(retryDelay(attempt, retryAfterSeconds(answer.headers)), signal);
    }
  }

  /**
   * The result's body (retried until it starts), as a stream that fails when no data arrives
   * for `timeout`.
   */
  async #openDownload(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    // A custom header would make a browser ask the download link for permission first (CORS).
    const headers = isBrowser() ? {} : this.#clientHeaders();
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.maxRetries;
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => {
        controller.abort();
      }, this.timeout);
      let response: Response;
      try {
        response = await this.#fetch(url, { headers, signal: combined, redirect: 'follow' });
      } catch (error) {
        clearTimeout(timer);
        if (signal?.aborted) throw signal.reason;
        const failure = controller.signal.aborted
          ? new APITimeoutError(`The request to ${host(url)} timed out.`)
          : connectionError(error, url);
        if (last) throw failure;
        await clock.sleep(retryDelay(attempt, null), signal);
        continue;
      }
      clearTimeout(timer);
      if (response.ok) return guardBody(response.body, this.timeout, controller, signal, url);
      const answer: Answer = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        text: await response.text().catch(() => ''),
      };
      if (last || !RETRY_STATUSES.has(answer.status)) throw errorFromAnswer(answer);
      await clock.sleep(retryDelay(attempt, retryAfterSeconds(answer.headers)), signal);
    }
  }
}

/** A body that fails with {@linkcode APITimeoutError} when no data arrives for `timeout`. */
function guardBody(
  body: ReadableStream<Uint8Array> | null,
  timeout: number,
  controller: AbortController,
  signal: AbortSignal | undefined,
  url: string,
): ReadableStream<Uint8Array> {
  if (!body)
    return new ReadableStream({
      start: (stream) => {
        stream.close();
      },
    });
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new APITimeoutError(`The download from ${host(url)} stalled.`);
          controller.abort(error);
          reject(error);
        }, timeout);
      });
      try {
        const chunk = await Promise.race([reader.read(), idle]);
        if (chunk.done) stream.close();
        else stream.enqueue(chunk.value);
      } catch (error) {
        if (signal?.aborted) stream.error(signal.reason);
        else if (error instanceof ConverterStudioError) stream.error(error);
        else stream.error(connectionError(error, url));
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
