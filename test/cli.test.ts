import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { main } from '../src/cli.ts';
import { VERSION } from '../src/index.ts';
import { BASE, FakeAPI, KEY, errorResponse } from './fake-api.ts';
import { fakeClock, tempDir, textOf } from './helpers.ts';

let api: FakeAPI;
const realFetch = globalThis.fetch;

beforeEach(() => {
  api = new FakeAPI();
  fakeClock();
  globalThis.fetch = api.fetch as typeof fetch;
  process.env['CONVERTER_STUDIO_API_KEY'] = KEY;
  process.env['CONVERTER_STUDIO_BASE_URL'] = BASE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['CONVERTER_STUDIO_API_KEY'];
  delete process.env['CONVERTER_STUDIO_BASE_URL'];
});

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(args, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  // The key is never printed, whatever happens.
  assert.ok(!out.includes(KEY) && !err.includes(KEY), 'the API key was printed');
  return { code, out, err };
}

function file(dir: string, name: string, content = 'DATA'): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('convert', () => {
  test('several files, saved paths on stdout and progress on stderr', async () => {
    const dir = tempDir();
    const out = join(dir, 'out');
    const result = await run(
      'convert',
      file(dir, 'a.heic'),
      file(dir, 'b.heic'),
      '--to',
      '.JPG',
      '-o',
      out,
    );
    assert.equal(result.code, 0);
    assert.equal(result.out, `${join(out, 'a.jpg')}\n${join(out, 'b.jpg')}\n`);
    assert.match(
      result.err,
      /\[1\/2\] a\.heic -> jpg\n {2}saved .*a\.jpg \(6\.0 B|\[1\/2\] a\.heic -> jpg/,
    );
    assert.match(result.err, /1 credit\)/);
    assert.equal(readFileSync(join(out, 'b.jpg'), 'utf8'), 'RESULT');
    const again = await run('convert', join(dir, 'a.heic'), '-t', 'jpg', '-o', out, '-q');
    assert.equal(again.out, `${join(out, 'a-1.jpg')}\n`);
    assert.equal(again.err, '');
    const replaced = await run(
      'convert',
      join(dir, 'a.heic'),
      '-t',
      'jpg',
      '-o',
      out,
      '--overwrite',
    );
    assert.equal(replaced.out, `${join(out, 'a.jpg')}\n`);
  });

  test('settings are typed, and KEY:=JSON sends JSON', async () => {
    const dir = tempDir();
    const result = await run(
      'convert',
      'https://example.com/photo.heic',
      '--to',
      'jpg',
      '-o',
      dir,
      '-O',
      'keepMetadata=true',
      '-O',
      'maxKb=500',
      '-O',
      'height=720',
      '-O',
      'quality:="high"',
      '--max-credits',
      '3',
    );
    assert.equal(result.code, 0);
    const body = JSON.parse(textOf(api.of('POST', '/api/v1/conversions')[0]!.body)) as unknown;
    assert.deepEqual(body, {
      to: 'jpg',
      url: 'https://example.com/photo.heic',
      options: { keepMetadata: true, maxKb: 500, height: '720', quality: 'high' },
      maxCredits: 3,
    });
  });

  test('--json prints one object a file, without the download link', async () => {
    const dir = tempDir();
    const result = await run(
      'convert',
      'https://example.com/a.png',
      '-t',
      'webp',
      '-o',
      dir,
      '--json',
    );
    assert.equal(result.code, 0);
    assert.equal(result.err, '');
    const line = JSON.parse(result.out) as { output: string; conversion: Record<string, unknown> };
    assert.equal(line.output, join(dir, 'a.webp'));
    assert.equal(line.conversion['status'], 'done');
    assert.ok(!('downloadUrl' in line.conversion));
  });

  test('exit codes', async () => {
    const dir = tempDir();
    const input = file(dir, 'a.heic');
    assert.equal((await run('convert', input)).code, 2);
    assert.equal((await run('convert', '--to', 'jpg')).code, 2);
    assert.equal((await run('convert', join(dir, 'missing.heic'), '--to', 'jpg')).code, 2);
    assert.equal((await run('convert', input, '--to', 'jpg', '-O', 'mute=maybe')).code, 2);
    assert.equal((await run('convert', input, '--to', 'jpg', '-O', 'novalue')).code, 2);
    assert.equal((await run('convert', input, '--to', 'jpg', '--max-credits', '-1')).code, 2);
    assert.equal((await run('convert', input, '--to', 'jpg', '--timeout', 'x')).code, 2);
    assert.equal((await run('convert', input, '--to', 'jpg', '--unknown')).code, 2);
    assert.equal((await run('nonsense')).code, 2);
    assert.equal((await run()).code, 2);

    delete process.env['CONVERTER_STUDIO_API_KEY'];
    const noKey = await run('convert', input, '--to', 'jpg', '-o', dir);
    assert.equal(noKey.code, 3);
    assert.match(noKey.err, /No API key/);
    process.env['CONVERTER_STUDIO_API_KEY'] = 'cvs_live_wrong';
    const wrong = await run('convert', input, input, '--to', 'jpg', '-o', dir);
    assert.equal(wrong.code, 3);
    assert.match(wrong.err, /This API key does not work\. \[invalidApiKey\]/);
    // The second file is not tried with a key that does not work.
    assert.equal(api.of('POST', '/api/v1/uploads').length, 1);
    process.env['CONVERTER_STUDIO_API_KEY'] = KEY;

    api.credits = 5;
    const quoted = await run('convert', input, '--to', 'jpg', '-o', dir, '--max-credits', '0');
    assert.equal(quoted.code, 4);
    assert.match(quoted.err, /Run again with --max-credits 5/);
    api.credits = 1;

    api.push('/api/v1/uploads', errorResponse(402, 'notEnoughCredits', 'Not enough credits.'));
    assert.equal((await run('convert', input, input, '--to', 'jpg', '-o', dir)).code, 4);

    api.statuses = ['processing', 'failed'];
    api.error = { code: 'conversionFailed', message: 'It could not be converted.' };
    const failed = await run('convert', input, '--to', 'jpg', '-o', dir);
    assert.equal(failed.code, 1);
    assert.match(failed.err, /a\.heic: It could not be converted\. \[conversionFailed\]/);

    api.statuses = ['processing'];
    assert.equal((await run('convert', input, '--to', 'jpg', '-o', dir, '--timeout', '3')).code, 5);
  });

  test('the key from a file', async () => {
    delete process.env['CONVERTER_STUDIO_API_KEY'];
    const dir = tempDir();
    const keyFile = file(dir, 'key.txt', `${KEY}\n`);
    assert.equal((await run('account', '--api-key-file', keyFile)).code, 0);
    assert.equal(api.requests[0]?.headers.get('authorization'), `Bearer ${KEY}`);
    const empty = file(dir, 'empty.txt', '\n');
    assert.equal((await run('account', '--api-key-file', empty)).code, 3);
  });
});

describe('formats, account and help', () => {
  test('formats', async () => {
    const all = await run('formats');
    assert.equal(all.code, 0);
    assert.match(
      all.out,
      /^heic {2}HEIC {7}image {9}-> jpg, png\nmov {3}QuickTime {2}video {9}-> mp4\n$/,
    );
    const json = await run('formats', '--from', 'mov', '--json');
    assert.deepEqual(
      (JSON.parse(json.out) as { id: string }[]).map((f) => f.id),
      ['mov'],
    );
    const unknown = await run('formats', '--from', 'xyz');
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /no such format: xyz/);
  });

  test('account', async () => {
    const result = await run('account');
    assert.equal(result.code, 0);
    assert.equal(
      result.out,
      'Account:   dev@example.com\n' +
        'Plan:      pro (All Apps)\n' +
        'Credits:   1099 left (1 of 1100 used this month), renews 2026-12-22\n' +
        'Limits:    files up to 1.1 GB, audio and video up to 120 min\n' +
        'Wallet:    $1.50, pays past the credits\n',
    );
    const json = await run('account', '--json');
    assert.equal((JSON.parse(json.out) as { plan: string }).plan, 'pro');
  });

  test('help and version', async () => {
    const help = await run('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: converter-studio <command>/);
    assert.match(help.out, /converter\.studio\/account#api-keys/);
    const version = await run('--version');
    assert.equal(version.out, `converter-studio ${VERSION}\n`);
  });
});
