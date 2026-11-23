/**
 * What the Converter Studio API returns, as typed, read-only objects. Each keeps the JSON it was
 * read from in `raw`, so a field the API adds later is reachable before this package names it.
 *
 * @module
 */

/**
 * Where a conversion stands. `quoted`: it costs more than its `maxCredits` and waits for
 * {@linkcode ConverterStudio.confirm}.
 */
export type ConversionStatus =
  | 'fetching'
  | 'waiting_for_upload'
  | 'measuring'
  | 'quoted'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'expired'
  | 'canceled';

/** A value in an error's `params`. */
export type ParamValue = string | number;

/** The statuses a conversion never leaves. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'expired',
  'canceled',
]);

/** The statuses nobody needs to wait past: finished, or waiting for a go-ahead (`quoted`). */
export const SETTLED_STATUSES: ReadonlySet<string> = new Set([...FINISHED_STATUSES, 'quoted']);

/**
 * A conversion's settings, the same as on the website (`{ quality: 'high' }`). The list, and
 * which settings apply to which conversion, is on https://converter.studio/developers.
 */
export type ConversionOptions = { readonly [name: string]: string | number | boolean };

/** Why a conversion failed, as the API says it: a stable code and a sentence for people. */
export interface ErrorInfo {
  /** A stable code: `conversionFailed`, `noText`, `wrongPassword`, `remoteNotFound`... */
  readonly code: string;
  /** An English sentence meant to be shown to people. */
  readonly message: string;
  /** The values in the message. */
  readonly params: Readonly<Record<string, ParamValue>>;
}

/** A conversion (`GET /v1/conversions/{id}`). Its id is also its upload's id. */
export interface Conversion {
  /** The conversion's id. */
  readonly id: string;
  /** Where it stands. */
  readonly status: ConversionStatus;
  /** The format read from the file, once known (`heic`). */
  readonly from: string | null;
  /** The format it converts to (`jpg`). */
  readonly to: string | null;
  /** The file's name. */
  readonly inputName: string | null;
  /** The file's size in bytes. */
  readonly inputSize: number | null;
  /** The price in credits, once known. */
  readonly credits: number | null;
  /** It goes ahead on its own up to this price; `null`: it waits for a go-ahead. */
  readonly maxCredits: number | null;
  /** From 0 to 1 while it converts. */
  readonly progress: number | null;
  /** The result's name. */
  readonly outputName: string | null;
  /** The result's size in bytes. */
  readonly outputSize: number | null;
  /** Anyone with this link can download the result until `expiresAt`. */
  readonly downloadUrl: string | null;
  /** When the result is deleted (ISO 8601). */
  readonly expiresAt: string | null;
  /** Why it failed, when it did. */
  readonly error: ErrorInfo | null;
  /** What to do next, in a sentence. */
  readonly next: string;
  /** The API answered a repeated request (the same `Idempotency-Key`) with this conversion. */
  readonly replayed: boolean;
  /** The JSON the API sent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** An upload slot (`POST /v1/uploads`); its file is sent to `uploadUrl`. */
export interface Upload {
  /** The upload's id, which its conversion keeps. */
  readonly id: string;
  /** Where the file goes (the link carries its own token: no API key is sent there). */
  readonly uploadUrl: string;
  /** How it is sent: `PUT`. */
  readonly method: string;
  /** The largest file the account's plan takes, in bytes. */
  readonly maxBytes: number | null;
  /** One request carries at most this many bytes; larger files go in parts. */
  readonly partBytes: number | null;
  /** When the slot is deleted if nothing arrives (ISO 8601). */
  readonly expiresAt: string | null;
  /** The JSON the API sent, without the upload link. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A format the API reads, and what it converts it to right now. */
export interface Format {
  /** Its id (`heic`). */
  readonly id: string;
  /** Its name (`HEIC`). */
  readonly name: string;
  /** `image`, `video`, `audio`, `document`... */
  readonly category: string;
  /** The file extensions it goes by. */
  readonly extensions: readonly string[];
  /** The formats it converts to, the most popular first. */
  readonly to: readonly string[];
  /** The JSON the API sent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The plan's credits this period. */
export interface Allowance {
  /** Credits used this period. */
  readonly used: number;
  /** Credits the plan gives each period. */
  readonly limit: number;
  /** `day` or `month`. */
  readonly per: string;
}

/** The web wallet, which pays for cloud work past the credits when allowed. */
export interface Wallet {
  /** The balance in millionths of a US dollar. */
  readonly balanceMicros: number;
  /** Whether it pays once the credits run out. */
  readonly pays: boolean;
}

/** The API key's account (`GET /v1/account`). */
export interface Account {
  /** The account's e-mail address. */
  readonly email: string;
  /** `free`, `pro`, `premium`... */
  readonly plan: string;
  /** Converter Studio on every platform (the app plan, Pro or Premium). */
  readonly allApps: boolean;
  /** Credits left: the plan's plus packs. */
  readonly credits: number;
  /** The plan's credits this period. */
  readonly allowance: Allowance | null;
  /** Credits left in packs (they never expire). */
  readonly packs: number;
  /** When the plan's credits renew (ISO 8601). */
  readonly renewsAt: string | null;
  /** The largest file the plan takes, in bytes. */
  readonly maxFileBytes: number | null;
  /** The longest audio or video the plan takes, in seconds. */
  readonly maxMediaSeconds: number | null;
  /** The web wallet, when the account has one. */
  readonly wallet: Wallet | null;
  /** The JSON the API sent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

type Json = Readonly<Record<string, unknown>>;

/** The value as a JSON object, or an empty one. */
export function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The string and number values of an object (an error's `params`). */
export function params(value: unknown): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, item] of Object.entries(asObject(value))) {
    if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
      out[key] = item;
  }
  return out;
}

function errorInfo(value: unknown): ErrorInfo | null {
  const body = asObject(value);
  const code = str(body['code']);
  if (code === null) return null;
  return { code, message: str(body['message']) ?? code, params: params(body['params']) };
}

/** A conversion from the API's JSON. */
export function toConversion(value: unknown, replayed = false): Conversion {
  const body = asObject(value);
  return {
    id: str(body['id']) ?? '',
    status: (str(body['status']) ?? 'failed') as ConversionStatus,
    from: str(body['from']),
    to: str(body['to']),
    inputName: str(body['inputName']),
    inputSize: int(body['inputSize']),
    credits: int(body['credits']),
    maxCredits: int(body['maxCredits']),
    progress: num(body['progress']),
    outputName: str(body['outputName']),
    outputSize: int(body['outputSize']),
    downloadUrl: str(body['downloadUrl']),
    expiresAt: str(body['expiresAt']),
    error: errorInfo(body['error']),
    next: str(body['next']) ?? '',
    replayed,
    raw: body,
  };
}

/** An upload slot from the API's JSON. */
export function toUpload(value: unknown): Upload {
  const body = asObject(value);
  const raw: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(body)) {
    if (key !== 'uploadUrl' && key !== 'curl') raw[key] = item;
  }
  return {
    id: str(body['id']) ?? '',
    uploadUrl: str(body['uploadUrl']) ?? '',
    method: str(body['method']) ?? 'PUT',
    maxBytes: int(body['maxBytes']),
    partBytes: int(body['partBytes']),
    expiresAt: str(body['expiresAt']),
    raw,
  };
}

/** A format from the API's JSON. */
export function toFormat(value: unknown): Format {
  const body = asObject(value);
  const id = str(body['id']) ?? '';
  return {
    id,
    name: str(body['name']) ?? id,
    category: str(body['category']) ?? '',
    extensions: strings(body['extensions']),
    to: strings(body['to']),
    raw: body,
  };
}

/** The account from the API's JSON. */
export function toAccount(value: unknown): Account {
  const body = asObject(value);
  const allowance = asObject(body['allowance']);
  const wallet = body['wallet'];
  return {
    email: str(body['email']) ?? '',
    plan: str(body['plan']) ?? '',
    allApps: body['allApps'] === true,
    credits: int(body['credits']) ?? 0,
    allowance:
      Object.keys(allowance).length > 0
        ? {
            used: int(allowance['used']) ?? 0,
            limit: int(allowance['limit']) ?? 0,
            per: str(allowance['per']) ?? '',
          }
        : null,
    packs: int(body['packs']) ?? 0,
    renewsAt: str(body['renewsAt']),
    maxFileBytes: int(body['maxFileBytes']),
    maxMediaSeconds: int(body['maxMediaSeconds']),
    wallet:
      typeof wallet === 'object' && wallet !== null
        ? {
            balanceMicros: int(asObject(wallet)['balanceMicros']) ?? 0,
            pays: asObject(wallet)['pays'] === true,
          }
        : null,
    raw: body,
  };
}
