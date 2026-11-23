/**
 * Reading a callback: what Converter Studio POSTs to a conversion's `callbackUrl`.
 *
 * @module
 */

import { asObject, toConversion, type Conversion } from './models.ts';

/** What a callback says happened. */
export type CallbackEventType =
  'conversion.quoted' | 'conversion.done' | 'conversion.failed' | 'conversion.canceled';

/** The callbacks Converter Studio sends, in the order they can come. */
export const CALLBACK_EVENTS: readonly CallbackEventType[] = [
  'conversion.quoted',
  'conversion.done',
  'conversion.failed',
  'conversion.canceled',
];

/**
 * A callback Converter Studio POSTed to a conversion's `callbackUrl`: once when the conversion
 * waits for a go-ahead (`conversion.quoted`), and once when it ends (`conversion.done`,
 * `conversion.failed` or `conversion.canceled`).
 *
 * Callbacks are not signed: keep the address secret, and look the conversion up with your own
 * key ({@linkcode ConverterStudio.getConversion}) before acting on one. The same delivery can
 * arrive more than once; its `id` (also the `Webhook-Id` header) is the same on every attempt.
 */
export interface CallbackEvent {
  /** What happened. */
  readonly event: CallbackEventType | (string & {});
  /** The delivery's id (`evt_...`), the same on every attempt. */
  readonly id: string;
  /** When it happened (ISO 8601). */
  readonly createdAt: string | null;
  /** The conversion as it was when it happened. */
  readonly conversion: Conversion;
}

/**
 * Reads a callback's body: the raw body (text or bytes), or the object a web framework already
 * parsed from its JSON.
 *
 * @example
 * ```ts
 * import { ConverterStudio, parseCallback } from 'converter-studio';
 *
 * const client = new ConverterStudio();
 * const event = parseCallback(await request.text());
 * if (event.event === 'conversion.done') {
 *   const conversion = await client.getConversion(event.conversion.id); // check it first
 *   await client.download(conversion, 'results/');
 * }
 * ```
 *
 * @throws {TypeError} when the body is not a Converter Studio callback
 */
export function parseCallback(
  body: string | Uint8Array | ArrayBuffer | Readonly<Record<string, unknown>>,
): CallbackEvent {
  let data: unknown = body;
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    try {
      data = JSON.parse(text);
    } catch {
      throw new TypeError('Not a Converter Studio callback: the body is not JSON');
    }
  }
  const object = asObject(data);
  const conversion = object['conversion'];
  if (
    typeof object['event'] !== 'string' ||
    typeof conversion !== 'object' ||
    conversion === null
  ) {
    throw new TypeError('Not a Converter Studio callback: no event or conversion');
  }
  return {
    event: object['event'],
    id: typeof object['id'] === 'string' ? object['id'] : '',
    createdAt: typeof object['createdAt'] === 'string' ? object['createdAt'] : null,
    conversion: toConversion(conversion),
  };
}
