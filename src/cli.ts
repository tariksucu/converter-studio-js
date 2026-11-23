#!/usr/bin/env node
/**
 * `converter-studio`: convert files from the command line (`npx converter-studio convert in.heic
 * --to jpg`).
 *
 * Exit codes: 0 all done; 1 a conversion or request failed; 2 wrong usage; 3 no API key, or the
 * key does not work; 4 not enough credits, or the price is over `--max-credits`; 5 a conversion
 * did not finish within `--timeout`; 130 interrupted. With several files, the first failure's.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  API_KEY_ENV,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConfirmationRequiredError,
  ConversionFailedError,
  ConversionTimeoutError,
  ConverterStudio,
  ConverterStudioError,
  DEFAULT_BASE_URL,
  InsufficientCreditsError,
  MissingApiKeyError,
  VERSION,
  type Account,
  type Conversion,
  type Format,
} from './index.ts';
import { isLink } from './files.ts';
import { parseOption } from './options.ts';

const DOCS = 'https://converter.studio/developers';
const EXIT = { ok: 0, failed: 1, usage: 2, key: 3, credits: 4, timeout: 5, interrupted: 130 };

const HELP = `Usage: converter-studio <command> [options]

Convert files with Converter Studio (https://converter.studio).

Commands:
  convert FILE_OR_URL... --to FORMAT   convert files or links and save the results
  formats [--from FORMAT]              list the formats and what they convert to (no key needed)
  account                              show the key's plan and credits

Options of convert:
  -t, --to FORMAT          the target format (jpg, mp4, pdf...)
  -o, --output-dir DIR     where results go (default: the current folder)
  -O, --option KEY=VALUE   a conversion setting, repeated for more; KEY:=JSON sends a JSON value
  --max-credits N          the most a conversion may cost to start on its own (default 20)
  --timeout SECONDS        how long to wait for each conversion (default 600)
  --overwrite              replace existing files (otherwise the result gets -1, -2...)
  -q, --quiet              print only errors

Options of every command:
  --json                   print JSON to stdout
  --api-key-file PATH      read the API key from a file instead of $${API_KEY_ENV}
  --base-url URL           another API address (default: $CONVERTER_STUDIO_BASE_URL or ${DEFAULT_BASE_URL})
  -h, --help, --version

The API key is read from $${API_KEY_ENV}; create one at
https://converter.studio/account#api-keys. Documentation: ${DOCS}
`;

interface Output {
  readonly json: boolean;
  readonly quiet: boolean;
  note(text: string): void;
  error(text: string): void;
  print(value: unknown): void;
}

/** Where the command writes: stdout and stderr (the tests pass their own). */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const STANDARD: Streams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function makeOutput(io: Streams, json: boolean, quiet: boolean): Output {
  return {
    json,
    quiet,
    note: (text) => {
      if (!quiet && !json) io.err(`${text}\n`);
    },
    error: (text) => {
      io.err(`converter-studio: ${text}\n`);
    },
    print: (value) => {
      io.out(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    },
  };
}

class UsageError extends Error {}

function parseOptions(pairs: readonly string[]): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    let key = at > 0 ? pair.slice(0, at).trim() : '';
    if (!key) throw new UsageError(`--option takes KEY=VALUE, not ${JSON.stringify(pair)}`);
    const value = pair.slice(at + 1);
    if (key.endsWith(':')) {
      key = key.slice(0, -1).trim();
      try {
        options[key] = JSON.parse(value) as string | number | boolean;
      } catch {
        throw new UsageError(`${key}:= takes a JSON value, not ${JSON.stringify(value)}`);
      }
    } else {
      try {
        options[key] = parseOption(key, value);
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
    }
  }
  return options;
}

function exitCode(error: unknown): number {
  if (error instanceof MissingApiKeyError || error instanceof AuthenticationError) return EXIT.key;
  if (error instanceof InsufficientCreditsError || error instanceof ConfirmationRequiredError)
    return EXIT.credits;
  if (error instanceof ConversionTimeoutError) return EXIT.timeout;
  return EXIT.failed;
}

/** An error in one line: the API's message, and its code when there is one. */
function describe(error: unknown): string {
  if (error instanceof ConfirmationRequiredError)
    return `${error.message} Run again with --max-credits ${error.credits ?? '?'} to go ahead.`;
  if (error instanceof BadRequestError && error.code === 'invalidRequest')
    return `${error.message} [${error.code}] Check the target format (converter-studio formats) and the options.`;
  const code = (error as { code?: unknown }).code;
  if (error instanceof ConverterStudioError)
    return typeof code === 'string' ? `${error.message} [${code}]` : error.message;
  return error instanceof Error ? error.message : String(error);
}

function humanSize(size: number | null): string {
  if (size === null) return '?';
  let value = size;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (value < 1000 || unit === 'GB')
      return unit === 'B' ? `${value} B` : `${value.toFixed(1)} ${unit}`;
    value /= 1000;
  }
  return `${size} B`;
}

function errorJson(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return {
    code: typeof code === 'string' ? code : null,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof APIError ? { status: error.status } : {}),
  };
}

function conversionJson(conversion: Conversion | null): Record<string, unknown> {
  if (!conversion) return {};
  const raw = Object.fromEntries(
    Object.entries(conversion.raw).filter(([key]) => key !== 'downloadUrl'),
  );
  return { conversion: raw };
}

async function runConvert(
  client: ConverterStudio,
  out: Output,
  inputs: readonly string[],
  flags: {
    to?: string | undefined;
    'output-dir'?: string | undefined;
    option?: string[] | undefined;
    'max-credits'?: string | undefined;
    timeout?: string | undefined;
    overwrite?: boolean | undefined;
  },
): Promise<number> {
  if (!flags.to) throw new UsageError('convert needs --to FORMAT');
  if (inputs.length === 0) throw new UsageError('convert needs at least one file or link');
  const options = parseOptions(flags.option ?? []);
  const missing = inputs.filter(
    (item) => !isLink(item) && !(existsSync(item) && statSync(item).isFile()),
  );
  if (missing.length > 0) throw new UsageError(`no such file: ${missing.join(', ')}`);
  let maxCredits: number | undefined;
  if (flags['max-credits'] !== undefined) {
    maxCredits = Number(flags['max-credits']);
    if (!Number.isInteger(maxCredits) || maxCredits < 0)
      throw new UsageError('--max-credits must be a whole number, 0 or more');
  }
  let timeout = 600_000;
  if (flags.timeout !== undefined) {
    timeout = Number(flags.timeout) * 1000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new UsageError('--timeout must be a number of seconds above 0');
  }
  const dir = flags['output-dir'] ?? '.';
  mkdirSync(dir, { recursive: true });
  const target = flags.to.toLowerCase().replace(/^\.+/, '');
  let firstFailure = EXIT.ok;
  for (const [index, item] of inputs.entries()) {
    const label = isLink(item) ? item : basename(item);
    out.note(`[${index + 1}/${inputs.length}] ${label} -> ${target}`);
    let conversion: Conversion | null = null;
    try {
      conversion = await client.convert(item, target, {
        options: Object.keys(options).length > 0 ? options : undefined,
        maxCredits,
        timeout,
      });
      const path = await client.download(conversion, `${dir}/`, {
        overwrite: flags.overwrite === true,
      });
      out.note(
        `  saved ${path} (${humanSize(conversion.outputSize)}, ${conversion.credits ?? '?'} ` +
          `credit${conversion.credits === 1 ? '' : 's'})`,
      );
      out.print(out.json ? { input: item, output: path, ...conversionJson(conversion) } : path);
    } catch (error) {
      const code = exitCode(error);
      if (firstFailure === EXIT.ok) firstFailure = code;
      if (error instanceof ConversionFailedError || error instanceof ConfirmationRequiredError)
        conversion = error.conversion;
      out.error(`${label}: ${describe(error)}`);
      if (out.json)
        out.print({ input: item, error: errorJson(error), ...conversionJson(conversion) });
      // A key that does not work, or no credits: the next files would fail the same way.
      if (code === EXIT.key || error instanceof InsufficientCreditsError) break;
    }
  }
  return firstFailure;
}

async function runFormats(client: ConverterStudio, out: Output, from?: string): Promise<number> {
  let formats: Format[];
  try {
    formats = await client.formats({ from });
  } catch (error) {
    if (!(error instanceof BadRequestError) || !from) throw error;
    formats = [];
  }
  if (out.json) {
    out.print(formats.map((item) => item.raw));
    return EXIT.ok;
  }
  if (formats.length === 0) {
    out.error(from ? `no such format: ${from}` : 'no formats');
    return EXIT.failed;
  }
  const width = Math.max(...formats.map((item) => item.id.length));
  const nameWidth = Math.max(...formats.map((item) => item.name.length));
  for (const item of formats) {
    out.print(
      `${item.id.padEnd(width)}  ${item.name.padEnd(nameWidth)}  ${item.category.padEnd(12)}  -> ` +
        (item.to.join(', ') || '-'),
    );
  }
  return EXIT.ok;
}

function accountLines(account: Account): [string, string][] {
  const lines: [string, string][] = [
    ['Account', account.email],
    ['Plan', account.plan + (account.allApps ? ' (All Apps)' : '')],
  ];
  let credits = `${account.credits} left`;
  if (account.allowance)
    credits +=
      ` (${account.allowance.used} of ${account.allowance.limit} used this ` +
      `${account.allowance.per || 'period'}${account.packs ? `, ${account.packs} in packs` : ''})`;
  if (account.renewsAt) credits += `, renews ${account.renewsAt.slice(0, 10)}`;
  lines.push(['Credits', credits]);
  if (account.maxFileBytes !== null) {
    let limit = `files up to ${humanSize(account.maxFileBytes)}`;
    if (account.maxMediaSeconds)
      limit += `, audio and video up to ${Math.floor(account.maxMediaSeconds / 60)} min`;
    lines.push(['Limits', limit]);
  }
  if (account.wallet)
    lines.push([
      'Wallet',
      `$${(account.wallet.balanceMicros / 1_000_000).toFixed(2)}` +
        (account.wallet.pays ? ', pays past the credits' : ''),
    ]);
  return lines;
}

/** Runs the command with `argv` (without `node` and the script) and returns its exit code. */
export async function main(argv: readonly string[], io: Streams = STANDARD): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        to: { type: 'string', short: 't' },
        'output-dir': { type: 'string', short: 'o' },
        option: { type: 'string', short: 'O', multiple: true },
        'max-credits': { type: 'string' },
        timeout: { type: 'string' },
        overwrite: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        json: { type: 'boolean' },
        from: { type: 'string' },
        'api-key-file': { type: 'string' },
        'base-url': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.err(`converter-studio: ${(error as Error).message}\n${HELP}`);
    return EXIT.usage;
  }
  const { values: flags, positionals } = parsed;
  if (flags.version) {
    io.out(`converter-studio ${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    if (flags.help) io.out(HELP);
    else io.err(HELP);
    return flags.help ? EXIT.ok : EXIT.usage;
  }
  const out = makeOutput(io, flags.json === true, flags.quiet === true);
  if (!['convert', 'formats', 'account'].includes(command)) {
    out.error(`unknown command: ${command} (convert, formats or account)`);
    return EXIT.usage;
  }
  let client: ConverterStudio;
  try {
    let apiKey: string | undefined;
    if (flags['api-key-file'] !== undefined) {
      apiKey = readFileSync(flags['api-key-file'], 'utf8').trim();
      if (!apiKey)
        throw new MissingApiKeyError(`The API key file ${flags['api-key-file']} is empty.`);
    }
    client = new ConverterStudio({ apiKey, baseUrl: flags['base-url'] });
  } catch (error) {
    out.error(describe(error));
    return error instanceof TypeError ? EXIT.usage : EXIT.key;
  }
  try {
    if (command === 'convert') return await runConvert(client, out, rest, flags);
    if (command === 'formats') return await runFormats(client, out, flags.from);
    const account = await client.account();
    if (out.json) out.print(account.raw);
    else
      for (const [label, value] of accountLines(account))
        out.print(`${`${label}:`.padEnd(10)} ${value}`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      out.error(error.message);
      return EXIT.usage;
    }
    out.error(describe(error));
    return exitCode(error);
  }
}

/** Whether this file was started as the command (not imported, as the tests do). */
function startedAsCommand(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsCommand()) {
  process.on('SIGINT', () => {
    process.stderr.write('converter-studio: interrupted\n');
    process.exit(EXIT.interrupted);
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`converter-studio: ${describe(error)}\n`);
      process.exitCode = EXIT.failed;
    },
  );
}
