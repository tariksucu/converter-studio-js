import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  CALLBACK_EVENTS,
  ConflictError,
  ConverterStudio,
  ConverterStudioError,
  FileTooLargeError,
  GoneError,
  InsufficientCreditsError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  UnprocessableError,
  VERSION,
  parseCallback,
} from '../src/index.ts';
import { freePath, partRanges, safeFileName } from '../src/files.ts';
import { toAccount, toConversion, toFormat } from '../src/models.ts';
import { parseOption } from '../src/options.ts';
import { requireServerFiles } from '../src/runtime.ts';
import { BASE, FakeAPI, KEY, jsonResponse } from './fake-api.ts';
import { bytes, setup, tempDir } from './helpers.ts';

describe('what the API sends', () => {
  test('a conversion keeps every field and its JSON', () => {
    const raw = {
      id: 'abc',
      status: 'done',
      from: 'heic',
      to: 'jpg',
      inputName: 'IMG.HEIC',
      inputSize: 1234,
      credits: 1,
      maxCredits: 20,
      progress: 1,
      outputName: 'IMG.jpg',
      outputSize: 99,
      downloadUrl: 'https://x.test/jobs/abc/download?token=t',
      expiresAt: '2026-11-23T07:00:00.000Z',
      error: null,
      next: 'Download it.',
      later: 'a field added later',
    };
    const conversion = toConversion(raw, true);
    assert.equal(conversion.id, 'abc');
    assert.equal(conversion.from, 'heic');
    assert.equal(conversion.inputSize, 1234);
    assert.equal(conversion.progress, 1);
    assert.equal(conversion.downloadUrl, raw.downloadUrl);
    assert.equal(conversion.replayed, true);
    assert.equal(conversion.raw['later'], 'a field added later');
  });

  test('missing and wrong fields do not throw', () => {
    const conversion = toConversion({ inputSize: '12', credits: 1.5, error: { message: 'x' } });
    assert.equal(conversion.id, '');
    assert.equal(conversion.status, 'failed');
    assert.equal(conversion.inputSize, null);
    assert.equal(conversion.credits, null);
    assert.equal(conversion.error, null);
    assert.equal(toConversion(null).next, '');
    const failed = toConversion({
      status: 'failed',
      error: { code: 'noText', params: { a: 1, b: true } },
    });
    assert.deepEqual(failed.error, { code: 'noText', message: 'noText', params: { a: 1 } });
  });

  test('formats and the account', () => {
    const format = toFormat({ id: 'heic', extensions: ['heic', 3], to: ['jpg'] });
    assert.deepEqual(
      [format.name, format.category, format.extensions, format.to],
      ['heic', '', ['heic'], ['jpg']],
    );
    const account = toAccount({ plan: 'free', credits: 13, allowance: null, wallet: null });
    assert.equal(account.allowance, null);
    assert.equal(account.wallet, null);
    assert.equal(account.allApps, false);
    assert.equal(account.packs, 0);
  });
});

describe('errors', () => {
  const cases: [number, typeof APIError][] = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [402, InsufficientCreditsError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [410, GoneError],
    [413, FileTooLargeError],
    [422, UnprocessableError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
    [418, APIError],
  ];
  for (const [status, ErrorClass] of cases) {
    test(`${status} is ${ErrorClass.name}`, async () => {
      const { api, client } = setup({ maxRetries: 0 });
      api.push(
        '/api/v1/account',
        jsonResponse(status, {
          error: { code: 'someCode', message: 'A sentence.', params: { needed: 3 } },
        }),
      );
      await assert.rejects(client.account(), (error: unknown) => {
        assert.ok(error instanceof ErrorClass);
        assert.ok(error instanceof APIError);
        assert.ok(error instanceof ConverterStudioError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, ErrorClass.name);
        assert.equal(error.status, status);
        assert.equal(error.code, 'someCode');
        assert.equal(error.message, 'A sentence.');
        assert.deepEqual(error.params, { needed: 3 });
        return true;
      });
    });
  }

  test('the site-style errors and answers that are not from the API', async () => {
    const { api, client } = setup({ maxRetries: 0 });
    api.push('/api/v1/account', jsonResponse(404, { error: 'notFound' }));
    await assert.rejects(client.account(), {
      code: 'notFound',
      message: "We couldn't find that conversion.",
    });
    api.push(
      '/api/v1/account',
      new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    await assert.rejects(client.account(), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, null);
      assert.equal(error.message, 'The Converter Studio API answered 502 Bad Gateway.');
      return true;
    });
    api.push(
      '/api/v1/account',
      new Response(null, { status: 301, headers: { Location: 'https://elsewhere.test/' } }),
    );
    await assert.rejects(client.account(), { status: 301, message: /answered 301/ });
  });

  test('Retry-After as an HTTP date', async () => {
    const { api, client, time } = setup({ maxRetries: 1 });
    const when = new Date(Date.now() + 10_000).toUTCString();
    api.push(
      '/api/v1/account',
      jsonResponse(503, { error: 'serverBusy' }, { 'Retry-After': when }),
    );
    await client.account();
    assert.ok(time.slept[0]! > 7000 && time.slept[0]! <= 10_000);
  });
});

describe('callbacks', () => {
  const body = {
    event: 'conversion.done',
    id: 'evt_123',
    createdAt: '2026-11-23T03:00:00.000Z',
    conversion: { id: 'abc', status: 'done', to: 'png', downloadUrl: 'https://x.test/d?token=t' },
  };

  test('from text, bytes, an ArrayBuffer or a parsed object', () => {
    for (const input of [
      JSON.stringify(body),
      bytes(JSON.stringify(body)),
      bytes(JSON.stringify(body)).buffer as ArrayBuffer,
      body,
    ]) {
      const event = parseCallback(input);
      assert.equal(event.event, 'conversion.done');
      assert.equal(event.id, 'evt_123');
      assert.equal(event.createdAt, '2026-11-23T03:00:00.000Z');
      assert.equal(event.conversion.id, 'abc');
      assert.equal(event.conversion.status, 'done');
    }
    assert.deepEqual(CALLBACK_EVENTS, [
      'conversion.quoted',
      'conversion.done',
      'conversion.failed',
      'conversion.canceled',
    ]);
  });

  test('anything else is refused', () => {
    for (const input of [
      'not json',
      '[]',
      '{"event": "conversion.done"}',
      '{"conversion": {}}',
      {},
    ])
      assert.throws(() => parseCallback(input), TypeError);
  });
});

describe('browsers', () => {
  function asBrowser<T>(run: () => T): T {
    const process = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
    const scope = globalThis as { document?: unknown };
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    scope.document = {};
    try {
      return run();
    } finally {
      delete scope.document;
      Object.defineProperty(globalThis, 'process', process);
    }
  }

  test('an API key is refused in a web page unless allowed', () => {
    const api = new FakeAPI();
    asBrowser(() => {
      assert.throws(
        () => new ConverterStudio({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch }),
        (error: unknown) => {
          assert.ok(error instanceof ConverterStudioError);
          assert.match(error.message, /does not belong in a web page/);
          assert.match(error.message, /dangerouslyAllowBrowser: true/);
          return true;
        },
      );
      assert.ok(new ConverterStudio({ baseUrl: BASE, fetch: api.fetch }));
      assert.ok(
        new ConverterStudio({
          apiKey: KEY,
          baseUrl: BASE,
          fetch: api.fetch,
          dangerouslyAllowBrowser: true,
        }),
      );
    });
  });
});

describe('helpers', () => {
  test('safe file names', () => {
    const cases: [string | null, string][] = [
      ['photo.jpg', 'photo.jpg'],
      ['a/b/c.png', 'c.png'],
      ['C:\\Users\\x\\d.pdf', 'd.pdf'],
      ['  .hidden.  ', 'hidden'],
      ['tab\there', 'tab_here'],
      ['', 'fallback.bin'],
      [null, 'fallback.bin'],
      ['..', 'fallback.bin'],
    ];
    for (const [name, expected] of cases)
      assert.equal(safeFileName(name, 'fallback.bin'), expected);
  });

  test('free paths', async () => {
    const files = requireServerFiles();
    const dir = tempDir();
    for (const name of ['a.jpg', 'a-1.jpg', 'x.tar.gz', 'README'])
      writeFileSync(join(dir, name), '');
    assert.equal(await freePath(files, join(dir, 'a.jpg')), join(dir, 'a-2.jpg'));
    assert.equal(await freePath(files, join(dir, 'x.tar.gz')), join(dir, 'x-1.tar.gz'));
    assert.equal(await freePath(files, join(dir, 'README')), join(dir, 'README-1'));
    assert.equal(await freePath(files, join(dir, 'new.png')), join(dir, 'new.png'));
  });

  test('part ranges', () => {
    assert.deepEqual(partRanges(0, 10), [[0, 0]]);
    assert.deepEqual(partRanges(10, 10), [[0, 10]]);
    assert.deepEqual(partRanges(25, 10), [
      [0, 10],
      [10, 10],
      [20, 5],
    ]);
  });

  test('settings typed on a command line', () => {
    assert.equal(parseOption('keepMetadata', 'yes'), true);
    assert.equal(parseOption('ocr', 'OFF'), false);
    assert.equal(parseOption('maxKb', '500'), 500);
    assert.equal(parseOption('trimStart', '1.5'), 1.5);
    assert.equal(parseOption('height', '720'), '720');
    assert.equal(parseOption('constructor', 'x'), 'x');
    assert.throws(() => parseOption('mute', 'maybe'), /true or false/);
    assert.throws(() => parseOption('maxKb', '1.5'), /whole number/);
    assert.throws(() => parseOption('trimEnd', 'soon'), /a number/);
  });

  test('the version is the same everywhere', () => {
    const read = (name: string): { version: string } =>
      JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as {
        version: string;
      };
    assert.equal(read('package.json').version, VERSION);
    assert.equal(read('jsr.json').version, VERSION);
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    assert.ok(changelog.includes(`## ${VERSION} - `));
  });
});
