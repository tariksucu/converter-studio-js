// Type tests: checked by `npm run typecheck` (tsc), never run. Each `@ts-expect-error` must fail.

import {
  ConverterStudio,
  parseCallback,
  type Account,
  type CallbackEvent,
  type Conversion,
  type ConversionStatus,
  type FetchLike,
  type Format,
  type Source,
  type Upload,
} from '../src/index.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T>(value: T): T {
  return value;
}
function assertTrue<T extends true>(): T | undefined {
  return undefined;
}

export async function typeTests(client: ConverterStudio): Promise<void> {
  // The global fetch is a FetchLike, and so is a plain function.
  new ConverterStudio({ fetch });
  new ConverterStudio({ fetch: (input: string) => fetch(input), timeout: 1000, maxRetries: 0 });
  // @ts-expect-error: the timeout is a number of milliseconds
  new ConverterStudio({ timeout: '60s' });
  // @ts-expect-error: no such setting
  new ConverterStudio({ apiKeys: 'x' });

  // Every kind of source.
  const sources: Source[] = [
    'photo.heic',
    new URL('file:///tmp/photo.heic'),
    'https://example.com/a.heic',
    new Blob(['x']),
    new File(['x'], 'a.png'),
    new Uint8Array(1),
    new ArrayBuffer(1),
    new DataView(new ArrayBuffer(1)),
    new Blob(['x']).stream(),
  ];
  void sources;
  // @ts-expect-error: a number is not a file
  await client.convert(42, 'jpg');

  const conversion = await client.convert('a.heic', 'jpg', {
    options: { quality: 'high', maxKb: 500, keepMetadata: true },
    maxCredits: 5,
    signal: AbortSignal.timeout(1000),
  });
  expectType<Conversion>(conversion);
  assertTrue<Equal<typeof conversion.status, ConversionStatus>>();
  assertTrue<Equal<typeof conversion.credits, number | null>>();
  assertTrue<Equal<typeof conversion.downloadUrl, string | null>>();
  // @ts-expect-error: conversions are read-only
  conversion.status = 'done';
  // @ts-expect-error: a setting's value is text, a number or a boolean
  await client.convert('a.heic', 'jpg', { options: { quality: ['high'] } });

  expectType<Promise<string>>(client.download(conversion, 'out/', { overwrite: true }));
  expectType<Promise<Uint8Array>>(client.downloadBytes(conversion.id));
  expectType<Promise<ReadableStream<Uint8Array>>>(client.downloadStream(conversion));
  expectType<Promise<Format[]>>(client.formats({ from: 'heic' }));
  expectType<Promise<Account>>(client.account());
  expectType<Promise<Upload>>(client.upload(new Uint8Array(1), { fileName: 'a.png', partSize: 1 }));
  expectType<Promise<Conversion>>(client.getConversion('id', { waitSeconds: 25 }));
  expectType<Promise<Conversion>>(client.wait(conversion, { timeout: 60_000 }));
  expectType<Promise<Conversion>>(client.confirm(conversion));
  await client.createConversion({
    to: 'jpg',
    url: 'https://example.com/a.heic',
    idempotencyKey: 'k',
  });
  // @ts-expect-error: the target format is needed
  await client.createConversion({ url: 'https://example.com/a.heic' });

  const event = parseCallback('{}');
  expectType<CallbackEvent>(event);
  if (event.event === 'conversion.done') expectType<Conversion>(event.conversion);

  const custom: FetchLike = async () => new Response('{}');
  void custom;
}
