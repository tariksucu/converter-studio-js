import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConfirmationRequiredError,
  ConflictError,
  ConversionFailedError,
  ConversionTimeoutError,
  ConverterStudio,
  ConverterStudioError,
  GoneError,
  MissingApiKeyError,
  RateLimitError,
  ServerError,
  VERSION,
} from '../src/index.ts';
import { SPOOL_BYTES, fileReading } from '../src/files.ts';
import { BASE, KEY, FakeAPI, errorResponse, hang, jsonResponse, networkError } from './fake-api.ts';
import { bytes, restoreClock, setup, tempDir, textOf } from './helpers.ts';

const CONVERSIONS = '/api/v1/conversions';

function writeFile(dir: string, name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('requests', () => {
  test('every request names the client, and only API requests carry the key', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const conversion = await client.convert(writeFile(dir, 'photo.heic', 'HEIC'), 'jpg');
    await client.download(conversion, `${dir}/`);
    const kinds = new Set(api.requests.map((r) => r.url.pathname.split('/')[3]));
    assert.deepEqual([...kinds].sort(), ['conversions', 'up00000001', 'uploads']);
    for (const request of api.requests) {
      assert.equal(request.headers.get('x-converter-studio-client'), `node/${VERSION}`);
      assert.match(
        request.headers.get('user-agent') ?? '',
        new RegExp(`^converter-studio-node/${VERSION.replaceAll('.', '\\.')} (node|deno|bun)/`),
      );
      const api_ =
        request.url.pathname.startsWith('/api/v1/') && !request.url.search.includes('token');
      assert.equal(request.headers.get('authorization'), api_ ? `Bearer ${KEY}` : null);
    }
  });

  test('formats need no key, and send it when there is one', async () => {
    const api = new FakeAPI();
    const anonymous = new ConverterStudio({ baseUrl: BASE, fetch: api.fetch });
    const formats = await anonymous.formats();
    assert.deepEqual(
      formats.map((f) => [f.id, f.to]),
      [
        ['heic', ['jpg', 'png']],
        ['mov', ['mp4']],
      ],
    );
    assert.equal(api.requests[0]?.headers.get('authorization'), null);
    const heic = await anonymous.formats({ from: '.HEIC' });
    assert.equal(heic.length, 1);
    assert.equal(api.requests[1]?.url.searchParams.get('from'), 'heic');
    const { api: keyed, client } = setup();
    await client.formats();
    assert.equal(keyed.requests[0]?.headers.get('authorization'), `Bearer ${KEY}`);
  });

  test('without a key nothing is sent', async () => {
    const api = new FakeAPI();
    const saved = process.env['CONVERTER_STUDIO_API_KEY'];
    delete process.env['CONVERTER_STUDIO_API_KEY'];
    try {
      const client = new ConverterStudio({ baseUrl: BASE, fetch: api.fetch });
      await assert.rejects(client.account(), (error: unknown) => {
        assert.ok(error instanceof MissingApiKeyError);
        assert.match(error.message, /CONVERTER_STUDIO_API_KEY/);
        assert.match(error.message, /converter\.studio\/account#api-keys/);
        return true;
      });
      assert.equal(api.requests.length, 0);
    } finally {
      if (saved !== undefined) process.env['CONVERTER_STUDIO_API_KEY'] = saved;
    }
  });

  test('the key and the address come from the environment', async () => {
    const api = new FakeAPI();
    process.env['CONVERTER_STUDIO_API_KEY'] = `  ${KEY}\n`;
    process.env['CONVERTER_STUDIO_BASE_URL'] = `${BASE}/`;
    try {
      const client = new ConverterStudio({ fetch: api.fetch });
      assert.equal(client.baseUrl, BASE);
      assert.equal((await client.account()).plan, 'pro');
      assert.equal(api.requests[0]?.headers.get('authorization'), `Bearer ${KEY}`);
      const given = new ConverterStudio({ apiKey: 'cvs_live_other', fetch: api.fetch });
      await assert.rejects(given.account(), AuthenticationError);
    } finally {
      delete process.env['CONVERTER_STUDIO_API_KEY'];
      delete process.env['CONVERTER_STUDIO_BASE_URL'];
    }
  });

  test('the key never shows when the client is logged or serialised', async () => {
    const { client } = setup();
    const { inspect } = await import('node:util');
    assert.ok(!inspect(client, { showHidden: true, depth: 5 }).includes(KEY));
    assert.ok(!JSON.stringify(client).includes(KEY));
  });

  test('a wrong key throws the API message', async () => {
    const { client } = setup({ apiKey: 'cvs_live_wrong' });
    await assert.rejects(client.account(), (error: unknown) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'invalidApiKey');
      assert.equal(error.message, 'This API key does not work.');
      assert.equal(error.name, 'AuthenticationError');
      return true;
    });
  });

  test('account', async () => {
    const { client } = setup();
    const account = await client.account();
    assert.equal(account.email, 'dev@example.com');
    assert.equal(account.plan, 'pro');
    assert.equal(account.allApps, true);
    assert.equal(account.credits, 1099);
    assert.deepEqual(account.allowance, { used: 1, limit: 1100, per: 'month' });
    assert.equal(account.maxFileBytes, 1073741824);
    assert.deepEqual(account.wallet, { balanceMicros: 1500000, pays: true });
    assert.equal(account.renewsAt, '2026-12-22T01:16:48.716Z');
  });
});

describe('converting', () => {
  test('a file, with settings', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const conversion = await client.convert(writeFile(dir, 'talk.mov', 'MOVIE'), 'MP4', {
      options: { height: '720', mute: true },
    });
    assert.equal(conversion.status, 'done');
    assert.equal(conversion.credits, 1);
    assert.equal(conversion.outputName, 'talk.mp4');
    const [slot] = api.of('POST', '/api/v1/uploads');
    assert.deepEqual(JSON.parse(textOf(slot!.body)), { fileName: 'talk.mov', size: 5 });
    const [put] = api.of('PUT', '/api/v1/uploads/up00000001');
    assert.equal(textOf(put!.body), 'MOVIE');
    assert.equal(put!.headers.get('content-type'), 'application/octet-stream');
    assert.equal(put!.headers.get('upload-offset'), null);
    const [create] = api.of('POST', CONVERSIONS);
    assert.deepEqual(JSON.parse(textOf(create!.body)), {
      to: 'mp4',
      uploadId: 'up00000001',
      options: { height: '720', mute: true },
    });
    assert.match(create!.headers.get('idempotency-key') ?? '', /^cvs-node-[0-9a-f]{32}$/);
    assert.equal(create!.headers.get('content-type'), 'application/json');
    const path = await client.download(conversion, dir);
    assert.equal(path, join(dir, 'talk.mp4'));
    assert.equal(readFileSync(path, 'utf8'), 'RESULT');
  });

  test('a file: URL, bytes, a Blob, a File, a stream and a Node.js stream', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const path = writeFile(dir, 'a.png', 'PNG1');
    const cases: [Parameters<ConverterStudio['convert']>[0], string | undefined, string, string][] =
      [
        [pathToFileURL(path), undefined, 'a.png', 'PNG1'],
        [bytes('BYTES'), 'b.png', 'b.png', 'BYTES'],
        [bytes('VIEW!').buffer as ArrayBuffer, 'c.png', 'c.png', 'VIEW!'],
        [new Blob(['BLOB']), 'd.png', 'd.png', 'BLOB'],
        [new File(['FILE'], 'e.png'), undefined, 'e.png', 'FILE'],
        [new Blob(['STREAM']).stream(), 'f.png', 'f.png', 'STREAM'],
        [Readable.from([Buffer.from('NODE'), Buffer.from('JS')]), 'g.png', 'g.png', 'NODEJS'],
      ];
    for (const [source, fileName, name, content] of cases) {
      const conversion = await client.convert(source, 'webp', { fileName });
      assert.equal(conversion.inputName, name);
      const put = api.of('PUT', `/api/v1/uploads/${conversion.id}`);
      assert.equal(textOf(put[0]!.body), content, name);
    }
  });

  test('a typed array view sends only its own bytes', async () => {
    const { api, client } = setup();
    const whole = bytes('xxHELLOxx');
    const conversion = await client.convert(whole.subarray(2, 7), 'txt', { fileName: 'h.md' });
    assert.equal(textOf(api.of('PUT', `/api/v1/uploads/${conversion.id}`)[0]!.body), 'HELLO');
  });

  test('a Node.js file stream gives its own name', async () => {
    const { client } = setup();
    const dir = tempDir();
    const { createReadStream } = await import('node:fs');
    const conversion = await client.convert(
      createReadStream(writeFile(dir, 'song.flac', 'FLAC')),
      'mp3',
    );
    assert.equal(conversion.inputName, 'song.flac');
  });

  test('bytes, streams and plain Blobs need a name', async () => {
    const { api, client } = setup();
    await assert.rejects(client.convert(bytes('x'), 'png'), TypeError);
    await assert.rejects(client.convert(new Blob(['x']), 'png'), TypeError);
    await assert.rejects(client.convert(new Blob(['x']).stream(), 'png'), /fileName is needed/);
    await assert.rejects(client.convert(join(tempDir(), 'missing.png'), 'png'), { code: 'ENOENT' });
    await assert.rejects(client.convert(tempDir(), 'png'), /Not a file/);
    await assert.rejects(
      client.convert(Readable.from(['text']), 'png', { fileName: 'a.txt' }),
      /bytes \(Uint8Array\), not text/,
    );
    await assert.rejects(client.convert(new URL('ftp://example.com/a.png'), 'png'), TypeError);
    assert.equal(api.requests.length, 0);
  });

  test('a large stream is kept in a temporary file, deleted afterwards', async () => {
    const { api, client } = setup();
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('converter-studio-')));
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    const count = SPOOL_BYTES / chunk.byteLength + 2;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < count; i++) yield chunk;
    }
    const upload = await client.upload(chunks(), {
      fileName: 'big.bin',
      partSize: 3 * 1024 * 1024,
    });
    const parts = api.requests.filter((r) => r.method === 'PUT');
    assert.equal(parts.length, Math.ceil(count / 3));
    assert.equal(
      parts.reduce((sum, r) => sum + r.body.byteLength, 0),
      count * chunk.byteLength,
    );
    assert.ok(upload.id);
    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('converter-studio-') && !n.startsWith('converter-studio-test-'),
    );
    assert.deepEqual(
      after.filter((n) => !before.has(n)),
      [],
    );
  });

  test('a link is fetched by Converter Studio itself', async () => {
    const { api, client } = setup();
    const conversion = await client.convert('https://example.com/files/report.docx', 'pdf');
    assert.equal(conversion.status, 'done');
    assert.equal(api.of('POST', '/api/v1/uploads').length, 0);
    const [create] = api.of('POST', CONVERSIONS);
    assert.deepEqual(JSON.parse(textOf(create!.body)), {
      to: 'pdf',
      url: 'https://example.com/files/report.docx',
    });
    await client.convert(new URL('http://example.com/a.heic'), 'jpg');
    assert.equal(
      (JSON.parse(textOf(api.of('POST', CONVERSIONS)[1]!.body)) as { url: string }).url,
      'http://example.com/a.heic',
    );
  });

  test('without waiting', async () => {
    const { api, client } = setup();
    const created = await client.convert('https://example.com/a.heic', 'jpg', { wait: false });
    assert.equal(created.status, 'fetching');
    assert.equal(api.requests.length, 1);
  });

  test('a callback address and a price limit are sent', async () => {
    const { api, client } = setup();
    await client.createConversion({
      to: 'mp4',
      url: 'https://example.com/clip.mov',
      callbackUrl: 'https://example.com/hooks/cs?token=SECRET',
      maxCredits: 0,
      idempotencyKey: 'clip-42',
    });
    const [create] = api.of('POST', CONVERSIONS);
    assert.deepEqual(JSON.parse(textOf(create!.body)), {
      to: 'mp4',
      url: 'https://example.com/clip.mov',
      maxCredits: 0,
      callbackUrl: 'https://example.com/hooks/cs?token=SECRET',
    });
    assert.equal(create!.headers.get('idempotency-key'), 'clip-42');
  });

  test('settings are checked before anything is sent', async () => {
    const { api, client } = setup();
    await assert.rejects(client.createConversion({ to: 'jpg' }), /either url or uploadId/);
    await assert.rejects(
      client.createConversion({ to: 'jpg', url: 'https://x.test/a', uploadId: 'up00000001' }),
      /either url or uploadId/,
    );
    await assert.rejects(
      client.createConversion({ to: ' ', url: 'https://x.test/a' }),
      /to \(the format/,
    );
    await assert.rejects(
      client.createConversion({ to: 'jpg', url: 'https://x.test/a', maxCredits: -1 }),
      /maxCredits/,
    );
    await assert.rejects(
      client.createConversion({ to: 'jpg', url: 'https://x.test/a', maxCredits: 1.5 }),
      /maxCredits/,
    );
    for (const key of ['', 'has space', 'ü', 'x'.repeat(256)])
      await assert.rejects(
        client.createConversion({ to: 'jpg', url: 'https://x.test/a', idempotencyKey: key }),
        /idempotencyKey/,
      );
    await assert.rejects(client.upload(bytes('x'), { fileName: 'a', partSize: 0 }), /partSize/);
    await assert.rejects(client.getConversion(''), /conversion id/);
    await assert.rejects(client.wait('up1', { timeout: 0 }), /timeout/);
    assert.equal(api.requests.length, 0);
    assert.throws(() => new ConverterStudio({ maxRetries: -1 }), /maxRetries/);
    assert.throws(() => new ConverterStudio({ timeout: 0 }), /timeout/);
    assert.throws(() => new ConverterStudio({ baseUrl: 'ftp://x.test' }), /http/);
    assert.throws(() => new ConverterStudio({ baseUrl: 'not a url' }), /http/);
    assert.throws(() => new ConverterStudio({ baseUrl: 'https://x.test/api?k=1' }), /query/);
    assert.throws(() => new ConverterStudio({ baseUrl: 'https://u:p@x.test/api' }), /user name/);
    assert.throws(() => new ConverterStudio({ apiKey: 'cvs_live_ü' }), /characters/);
  });
});

describe('parts', () => {
  test('where a Blob would hold the whole file (Deno), parts are read from the file', async () => {
    const saved = { ...fileReading };
    fileReading.lazyBlobs = false;
    fileReading.readPartBytes = 4;
    try {
      const { api, client } = setup();
      const dir = tempDir();
      const upload = await client.upload(writeFile(dir, 'notes.txt', 'abcdefghij'), {
        partSize: 6,
      });
      assert.deepEqual(
        api
          .of('PUT', `/api/v1/uploads/${upload.id}`)
          .map((r) => [r.headers.get('upload-offset'), textOf(r.body)]),
        [
          ['0', 'abcd'],
          ['4', 'efgh'],
          ['8', 'ij'],
        ],
      );
      // A stream large enough for a temporary file is read the same way.
      fileReading.readPartBytes = 4 * 1024 * 1024;
      const big = new Uint8Array(SPOOL_BYTES + 5).fill(1);
      const streamed = await client.upload(new Blob([big]).stream(), { fileName: 'big.bin' });
      const sizes = api.of('PUT', `/api/v1/uploads/${streamed.id}`).map((r) => r.body.byteLength);
      assert.deepEqual(sizes, [4194304, 4194304, 5]);
      // A file that shrinks while it is sent is an error, not a short upload.
      const path = writeFile(dir, 'shrinks.bin', '0123456789');
      api.push('/api/v1/uploads/up00000003', () => {
        writeFileSync(path, '01');
        return errorResponse(503, 'serverBusy', 'Busy.');
      });
      await assert.rejects(client.upload(path, { partSize: 6 }), /got shorter/);
    } finally {
      Object.assign(fileReading, saved);
    }
  });

  test('large files go in parts', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const content = 'abcdefghijklmnopqrstuvwxyz';
    const upload = await client.upload(writeFile(dir, 'big.wav', content), { partSize: 10 });
    const puts = api.of('PUT', `/api/v1/uploads/${upload.id}`);
    assert.deepEqual(
      puts.map((r) => [r.headers.get('upload-offset'), textOf(r.body)]),
      [
        ['0', 'abcdefghij'],
        ['10', 'klmnopqrst'],
        ['20', 'uvwxyz'],
      ],
    );
    assert.equal(textOf(api.uploads.get(upload.id)!.data), content);
    assert.deepEqual(JSON.parse(textOf(api.of('POST', '/api/v1/uploads')[0]!.body)), {
      fileName: 'big.wav',
      size: 26,
    });
    assert.ok(!('uploadUrl' in upload.raw));
    assert.ok(!('curl' in upload.raw));
  });

  test('a part is sent again after a failure', async () => {
    const { api, client, time } = setup();
    api.push(
      '/api/v1/uploads/up00000001',
      errorResponse(503, 'serverBusy', 'Busy.'),
      networkError(),
    );
    const upload = await client.upload(bytes('0123456789ABC'), { fileName: 'a.bin', partSize: 10 });
    const puts = api.of('PUT', `/api/v1/uploads/${upload.id}`);
    assert.deepEqual(
      puts.map((r) => r.headers.get('upload-offset')),
      ['0', '0', '0', '10'],
    );
    assert.equal(textOf(api.uploads.get(upload.id)!.data), '0123456789ABC');
    assert.equal(time.slept.length, 2);
  });

  test('a last part whose answer was lost counts as sent', async () => {
    const { api, client } = setup();
    // The file arrives, but the answer does not; the retry finds the slot gone (404).
    api.push('/api/v1/uploads/up00000001', async () => {
      api.uploads.delete('up00000001');
      throw networkError();
    });
    const upload = await client.upload(bytes('DATA'), { fileName: 'a.bin' });
    assert.equal(upload.id, 'up00000001');
    assert.equal(api.of('PUT', '/api/v1/uploads/up00000001').length, 2);
  });

  test('a part that keeps failing throws', async () => {
    const { api, client } = setup({ maxRetries: 1 });
    api.push(
      '/api/v1/uploads/up00000001',
      errorResponse(503, 'serverBusy', 'Busy.'),
      errorResponse(503, 'serverBusy', 'Busy.'),
    );
    await assert.rejects(client.upload(bytes('DATA'), { fileName: 'a.bin' }), ServerError);
    api.push(
      '/api/v1/uploads/up00000002',
      errorResponse(413, 'fileTooLarge', 'Too large.', { maxSize: '1 GB' }),
    );
    await assert.rejects(client.upload(bytes('DATA'), { fileName: 'b.bin' }), {
      name: 'FileTooLargeError',
      params: { maxSize: '1 GB' },
    });
  });
});

describe('retries', () => {
  test('network errors are retried', async () => {
    const { api, client, time } = setup();
    api.push('/api/v1/account', networkError(), networkError('ECONNREFUSED'));
    assert.equal((await client.account()).plan, 'pro');
    assert.equal(api.of('GET', '/api/v1/account').length, 3);
    assert.equal(time.slept.length, 2);
    // An exponential back-off with jitter: 0.25–0.5 s, then 0.5–1 s.
    assert.ok(time.slept[0]! >= 250 && time.slept[0]! <= 500);
    assert.ok(time.slept[1]! >= 500 && time.slept[1]! <= 1000);
  });

  test('a retried conversion keeps its idempotency key', async () => {
    const { api, client } = setup();
    api.push(CONVERSIONS, errorResponse(502, 'serverBusy', 'Busy.'), networkError());
    await client.createConversion({ to: 'jpg', url: 'https://example.com/a.heic' });
    const keys = api.of('POST', CONVERSIONS).map((r) => r.headers.get('idempotency-key'));
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 1);
    await client.createConversion({ to: 'jpg', url: 'https://example.com/a.heic' });
    const next = api.of('POST', CONVERSIONS)[3]!.headers.get('idempotency-key');
    assert.notEqual(next, keys[0]);
  });

  test('an idempotent retry after a lost answer gives the first conversion', async () => {
    const { api, client } = setup();
    // The first request starts the conversion, but its answer is lost on the way back.
    api.push(CONVERSIONS, async (request) => {
      const created = await api.fetch(request.url.toString(), {
        method: 'POST',
        headers: request.headers,
        body: request.body as Uint8Array<ArrayBuffer>,
      });
      assert.equal(created.status, 201);
      throw networkError();
    });
    const conversion = await client.createConversion({
      to: 'jpg',
      url: 'https://example.com/a.heic',
    });
    assert.equal(conversion.replayed, true);
    assert.equal(api.jobs.size, 1);
  });

  test('Retry-After is followed, and a 429 that lasts throws', async () => {
    const { api, client, time } = setup();
    api.push(
      '/api/v1/account',
      errorResponse(429, 'tooManyRequests', 'Slow down.', undefined, { 'Retry-After': '3' }),
    );
    await client.account();
    assert.deepEqual(time.slept, [3000]);
    const limited = (): Response =>
      errorResponse(429, 'tooManyRequests', 'Slow down.', undefined, { 'Retry-After': '120' });
    api.push('/api/v1/account', limited(), limited(), limited());
    await assert.rejects(client.account(), (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfter, 120);
      assert.equal(error.headers['retry-after'], '120');
      return true;
    });
    // At most a minute between tries.
    assert.deepEqual(time.slept.slice(1), [60_000, 60_000]);
  });

  test('retries run out, and the error names only the host', async () => {
    const { api, client, time } = setup({ maxRetries: 1 });
    api.push('/api/v1/uploads/up00000001', networkError(), networkError());
    await assert.rejects(client.upload(bytes('x'), { fileName: 'a.bin' }), (error: unknown) => {
      assert.ok(error instanceof APIConnectionError);
      assert.equal(error.message, 'Could not reach api.test: ECONNRESET');
      assert.ok(!error.message.includes('tok_'));
      return true;
    });
    assert.equal(time.slept.length, 1);
  });

  test('requests that are not right are not retried', async () => {
    const { api, client } = setup();
    api.push(
      CONVERSIONS,
      errorResponse(400, 'invalidRequest', "Something about that request wasn't right."),
    );
    await assert.rejects(
      client.createConversion({ to: 'xyz', url: 'https://example.com/a' }),
      BadRequestError,
    );
    assert.equal(api.of('POST', CONVERSIONS).length, 1);
  });

  test('a request that gets no answer times out, and is retried', async () => {
    const { api, client } = setup({ timeout: 20, maxRetries: 1 });
    api.push('/api/v1/account', hang, hang);
    await assert.rejects(client.account(), (error: unknown) => {
      assert.ok(error instanceof APITimeoutError);
      assert.equal(error.message, 'The request to api.test timed out.');
      return true;
    });
    assert.equal(api.of('GET', '/api/v1/account').length, 2);
  });

  test('replays and conflicts', async () => {
    const { client } = setup();
    const first = await client.createConversion({
      to: 'webp',
      url: 'https://x.test/a.png',
      idempotencyKey: 'k1',
    });
    const again = await client.createConversion({
      to: 'webp',
      url: 'https://x.test/a.png',
      idempotencyKey: 'k1',
    });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.id, first.id);
    await assert.rejects(
      client.createConversion({ to: 'png', url: 'https://x.test/a.png', idempotencyKey: 'k1' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'idempotencyKeyReused',
    );
  });
});

describe('waiting', () => {
  test('a failed conversion throws the API reason', async () => {
    const { api, client } = setup();
    api.statuses = ['processing', 'failed'];
    api.error = {
      code: 'conversionFailed',
      message: 'This file could not be converted. Your credits were given back.',
      params: { stage: 'decode' },
    };
    await assert.rejects(
      client.convert(bytes('x'), 'png', { fileName: 'broken.jpg' }),
      (error: unknown) => {
        assert.ok(error instanceof ConversionFailedError);
        assert.equal(error.code, 'conversionFailed');
        assert.match(error.message, /credits were given back/);
        assert.deepEqual(error.params, { stage: 'decode' });
        assert.equal(error.conversion.status, 'failed');
        return true;
      },
    );
  });

  test('expired and canceled conversions', async () => {
    for (const [status, code] of [
      ['expired', 'fileExpired'],
      ['canceled', 'canceled'],
    ] as const) {
      const { api, client } = setup();
      api.statuses = ['processing', status];
      await assert.rejects(
        client.convert('https://x.test/a.heic', 'jpg'),
        (error: unknown) => error instanceof ConversionFailedError && error.code === code,
      );
    }
  });

  test('a price over the limit waits for a go-ahead', async () => {
    const { api, client } = setup();
    api.credits = 5;
    await assert.rejects(
      client.convert('https://x.test/l.mkv', 'mp4', { maxCredits: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof ConfirmationRequiredError);
        assert.equal(error.credits, 5);
        assert.equal(error.maxCredits, 2);
        assert.match(error.message, /costs 5 credits, more than the 2 allowed/);
        return true;
      },
    );
    const conversion = await client.wait(await client.confirm('ln00000001'));
    assert.equal(conversion.status, 'done');
    assert.equal(api.of('POST', '/api/v1/conversions/ln00000001/confirm').length, 1);
  });

  test('waiting uses long polls, and pauses only after early answers', async () => {
    const { api, client, time } = setup();
    api.statuses = ['processing', 'processing', 'processing', 'done'];
    const created = await client.convert('https://x.test/a.heic', 'jpg', { wait: false });
    await client.wait(created);
    const polls = api.of('GET', '/api/v1/conversions/ln00000001');
    assert.deepEqual(
      polls.map((r) => r.url.searchParams.get('wait')),
      ['25', '25', '25', '25'],
    );
    assert.deepEqual(time.slept, [1000, 2000, 4000]);
    // A long poll that took its time needs no pause.
    const slow = setup();
    slow.api.statuses = ['processing', 'processing', 'done'];
    slow.api.onLongPoll = (seconds) => {
      slow.time.now += seconds * 1000;
    };
    await slow.client.convert('https://x.test/a.heic', 'jpg');
    assert.deepEqual(slow.time.slept, []);
  });

  test('waiting times out', async () => {
    const { api, client } = setup();
    api.statuses = ['processing'];
    api.onLongPoll = () => undefined;
    await assert.rejects(
      client.convert('https://x.test/a.heic', 'jpg', { timeout: 5000 }),
      (error: unknown) => {
        assert.ok(error instanceof ConversionTimeoutError);
        assert.match(error.message, /within 5 seconds \(it is processing\).*ln00000001/);
        assert.equal(error.conversion.id, 'ln00000001');
        return true;
      },
    );
    const polls = api.of('GET', '/api/v1/conversions/ln00000001');
    assert.ok(polls.every((r) => Number(r.url.searchParams.get('wait')) <= 5));
  });

  test('getConversion now, and with a long poll', async () => {
    const { api, client } = setup();
    await client.convert('https://x.test/a.heic', 'jpg', { wait: false });
    const now = await client.getConversion('ln00000001');
    assert.equal(now.status, 'processing');
    await client.getConversion(now, { waitSeconds: 600 });
    const polls = api.of('GET', '/api/v1/conversions/ln00000001');
    assert.equal(polls[0]!.url.search, '');
    assert.equal(polls[1]!.url.searchParams.get('wait'), '60');
  });
});

describe('aborting', () => {
  test('a signal stops waiting, and nothing more is sent', async () => {
    const api = new FakeAPI();
    api.statuses = ['processing'];
    const client = new ConverterStudio({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch });
    const controller = new AbortController();
    api.push('/api/v1/conversions/ln00000001', (request, signal) => {
      controller.abort();
      return hang(request, signal);
    });
    const created = await client.convert('https://x.test/a.heic', 'jpg', { wait: false });
    const count = api.requests.length;
    await assert.rejects(client.wait(created, { signal: controller.signal }), {
      name: 'AbortError',
    });
    assert.equal(api.requests.length, count + 1);
  });

  test('an aborted signal sends nothing, and its reason is thrown', async () => {
    const { api, client } = setup();
    const reason = new Error('stopped by the user');
    await assert.rejects(client.account({ signal: AbortSignal.abort(reason) }), reason);
    assert.equal(api.requests.length, 0);
  });

  test('a signal stops the pause between retries', async () => {
    restoreClock(); // a real pause
    const api = new FakeAPI();
    const client = new ConverterStudio({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch });
    const controller = new AbortController();
    api.push('/api/v1/account', () => {
      setTimeout(() => {
        controller.abort();
      }, 5);
      return errorResponse(503, 'serverBusy', 'Busy.', undefined, { 'Retry-After': '30' });
    });
    const started = performance.now();
    await assert.rejects(client.account({ signal: controller.signal }), { name: 'AbortError' });
    assert.ok(performance.now() - started < 5000);
    assert.equal(api.requests.length, 1);
  });
});

describe('downloads', () => {
  test('into a folder, to a path, never replacing a file unless asked', async () => {
    const { api, client } = setup();
    api.output = bytes('JPEG');
    const dir = tempDir();
    const conversion = await client.convert('https://x.test/IMG_1.heic', 'jpg');
    const first = await client.download(conversion, dir);
    assert.equal(first, join(dir, 'IMG_1.jpg'));
    const second = await client.download(conversion, `${dir}/`);
    assert.equal(second, join(dir, 'IMG_1-1.jpg'));
    const replaced = await client.download(conversion, dir, { overwrite: true });
    assert.equal(replaced, first);
    const exact = join(dir, 'sub', 'photo.jpeg');
    assert.equal(await client.download(conversion, exact), exact);
    await assert.rejects(client.download(conversion, exact), { code: 'EEXIST' });
    assert.equal(await client.download(conversion, exact, { overwrite: true }), exact);
    assert.equal(readFileSync(exact, 'utf8'), 'JPEG');
    const fresh = join(dir, 'new-folder/');
    assert.equal(await client.download(conversion, fresh), join(dir, 'new-folder', 'IMG_1.jpg'));
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.part')),
      [],
    );
  });

  test('into the current folder by default, and numbered before a double extension', async () => {
    const { api, client } = setup();
    api.outputName = 'backup.tar.gz';
    const dir = tempDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const conversion = await client.convert('https://x.test/backup.zip', 'tar.gz');
      assert.equal(await client.download(conversion), join(dir, 'backup.tar.gz'));
      assert.equal(await client.download(conversion), join(dir, 'backup-1.tar.gz'));
    } finally {
      process.chdir(cwd);
    }
  });

  test('a result name cannot leave the folder', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    for (const [name, saved] of [
      ['../../etc/passwd', 'passwd'],
      ['..\\..\\boot.ini', 'boot.ini'],
      ['evil\u0000name.jpg', 'evil_name.jpg'],
      ['...', 'ln00000004.jpg'],
    ] as const) {
      api.outputName = name;
      const conversion = await client.convert('https://x.test/a.heic', 'jpg');
      const path = await client.download(conversion, dir);
      assert.equal(path, join(dir, saved));
    }
  });

  test('a download that fails leaves nothing behind', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const conversion = await client.convert('https://x.test/a.heic', 'jpg');
    api.push('/api/jobs/ln00000001/download', jsonResponse(410, { error: 'fileExpired' }));
    await assert.rejects(client.download(conversion, dir), (error: unknown) => {
      assert.ok(error instanceof GoneError);
      assert.equal(error.code, 'fileExpired');
      assert.equal(error.message, 'This file has already been deleted. Please convert it again.');
      return true;
    });
    assert.deepEqual(readdirSync(dir), []);
  });

  test('a download that breaks is started again', async () => {
    const { api, client } = setup();
    const dir = tempDir();
    const conversion = await client.convert('https://x.test/a.heic', 'jpg');
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes('RES'));
        } else {
          controller.error(new TypeError('terminated'));
        }
      },
    });
    api.push('/api/jobs/ln00000001/download', new Response(broken), networkError());
    const path = await client.download(conversion, dir);
    assert.equal(readFileSync(path, 'utf8'), 'RESULT');
    assert.deepEqual(readdirSync(dir), ['a.jpg']);
    assert.equal(api.of('GET', '/api/jobs/ln00000001/download').length, 3);
  });

  test('a download that stalls times out', async () => {
    const { api, client } = setup({ timeout: 30, maxRetries: 0 });
    const conversion = await client.convert('https://x.test/a.heic', 'jpg');
    api.push(
      '/api/jobs/ln00000001/download',
      new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })),
    );
    await assert.rejects(client.downloadBytes(conversion), (error: unknown) => {
      assert.ok(error instanceof APITimeoutError);
      assert.equal(error.message, 'The download from api.test stalled.');
      return true;
    });
  });

  test('by id, in memory and as a stream', async () => {
    const { api, client } = setup();
    api.statuses = ['done'];
    await client.convert('https://x.test/a.heic', 'jpg', { wait: false });
    assert.equal(textOf(await client.downloadBytes('ln00000001')), 'RESULT');
    const reader = (await client.downloadStream('ln00000001')).getReader();
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += textOf(chunk.value);
    }
    assert.equal(text, 'RESULT');
    const download = api.of('GET', '/api/jobs/ln00000001/download')[0]!;
    assert.equal(download.headers.get('authorization'), null);
    assert.equal(download.headers.get('x-converter-studio-client'), `node/${VERSION}`);
  });

  test('only done conversions download', async () => {
    const { api, client } = setup();
    await client.convert('https://x.test/a.heic', 'jpg', { wait: false });
    await assert.rejects(client.downloadBytes('ln00000001'), (error: unknown) => {
      assert.ok(error instanceof ConverterStudioError);
      assert.match(error.message, /not done yet \(it is processing\)/);
      return true;
    });
    api.statuses = ['failed'];
    api.error = { code: 'noText', message: 'There is no text in this file.' };
    await client.convert('https://x.test/b.pdf', 'txt', { wait: false });
    await assert.rejects(client.downloadBytes('ln00000002'), ConversionFailedError);
    api.statuses = ['quoted'];
    await client.convert('https://x.test/c.mkv', 'mp4', { wait: false });
    await assert.rejects(client.download('ln00000003', tempDir()), ConfirmationRequiredError);
  });
});
