# Converter Studio for JavaScript and TypeScript

The official JavaScript and TypeScript client and command-line tool for the
[Converter Studio](https://converter.studio) API. Convert iPhone photos (HEIC), camera RAW photos,
videos, audio, documents, spreadsheets, presentations, e-books, subtitles, fonts, data files and
archives (67 formats) from Node.js, Deno, Bun or a browser. The conversion runs on Converter
Studio's servers, so there is nothing else to install: no ImageMagick, no FFmpeg, no LibreOffice.

```ts
import { ConverterStudio } from 'converter-studio';

const client = new ConverterStudio(); // the API key comes from CONVERTER_STUDIO_API_KEY
const conversion = await client.convert('IMG_1234.HEIC', 'jpg');
await client.download(conversion, 'photos/'); // photos/IMG_1234.jpg
```

```console
$ npx converter-studio convert IMG_1234.HEIC IMG_1235.HEIC --to jpg --output-dir photos
```

- Node.js 22.12 or later, Deno, Bun and browsers, with the runtime's own `fetch`. No
  dependencies. An ES module with its TypeScript types; `require()` works too (Node.js 22.12+).
- Local files, `Blob` and `File` objects, bytes, streams or links (direct links and Google Drive,
  Dropbox or OneDrive share links), with any of the API's conversion settings.
- Large files are uploaded in parts, read from disk as they are sent; results are streamed to
  disk.
- Waiting with long polling and a back-off, retries with an `Idempotency-Key` so a retry never
  starts or charges a second conversion, an `AbortSignal` on every call, and errors that carry the
  API's code and message.

## Installation

```console
$ npm install converter-studio
```

The same with `pnpm add`, `yarn add` or `bun add`. In Deno, from JSR:
`deno add jsr:@converterstudio/converter-studio` (or import `npm:converter-studio`), and run with
`--allow-net` (plus `--allow-read` and `--allow-write` for files on disk, `--allow-env` for the key
from the environment).

Then create an API key on your [account page](https://converter.studio/account#api-keys) (keys
start with `cvs_live_`; keep them secret) and put it in the environment:

```console
$ export CONVERTER_STUDIO_API_KEY=cvs_live_...
```

Every conversion uses your account's credits, the same as on the website: free accounts get
credits every day, Pro and Premium their monthly credits. Most files cost 1 credit; audio and video
are priced by their length (video also by its frame size and the format made) once Converter
Studio has looked at them. See [pricing](https://converter.studio/pricing).

## Usage

### Convert a file

```ts
import { ConverterStudio } from 'converter-studio';

const client = new ConverterStudio(); // or new ConverterStudio({ apiKey: 'cvs_live_...' })

const conversion = await client.convert('talk.mov', 'mp4', { options: { height: '720' } });
console.log(conversion.status, conversion.credits, conversion.outputName); // done 1 talk.mp4
const path = await client.download(conversion, 'out/'); // a folder (ending in / or existing), or a file path
```

`convert()` uploads the file, starts the conversion and waits until it is done (10 minutes at
most by default: `timeout` in milliseconds). The source can be:

- a path (`string`, or a `file:` `URL`), in Node.js, Deno and Bun;
- a `Blob` or a `File` (a `File` brings its name);
- bytes (`Uint8Array`, a Node.js `Buffer`, another typed array or an `ArrayBuffer`), with a name:
  `client.convert(bytes, 'pdf', { fileName: 'report.docx' })`;
- a `ReadableStream` of bytes or a Node.js `Readable`, with a name (a stream from
  `fs.createReadStream()` brings its own). Large streams are kept in a temporary file while they
  are sent, so that a part can be sent again;
- a link (a `string` or `URL` starting with `http://` or `https://`): Converter Studio fetches the
  file itself, so it never passes through your machine.

`download()` never replaces an existing file in a folder unless `{ overwrite: true }`: the result
gets `-1`, `-2`... before its extension. The file appears only once it is complete. You can also
stream the result (`await client.downloadStream(conversion)`, a `ReadableStream`) or get it in
memory (`await client.downloadBytes(conversion)`, a `Uint8Array`). Results are kept for 6 hours,
and anyone with `conversion.downloadUrl` can download the result until `conversion.expiresAt`.

### Settings

`options` takes the API's conversion settings, the same as on the website. A few of them:

| Setting                                                          | For                                               |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `quality`: `'high'`, `'balanced'`, `'small'`                     | video, JPG, WebP, AVIF                            |
| `height`: `'1080'`, `'720'`, `'480'`, `'360'`                    | video (never upscaled)                            |
| `maxSize`: MB                                                    | MP4 that must fit a size                          |
| `maxKb`: KB                                                      | JPG, WebP, AVIF that must fit a size              |
| `longSide`, `resizeWidth`, `resizeHeight`, `fit`                 | resizing images                                   |
| `keepMetadata`, `keepLocation`: `true`                           | keep a photo's camera details and GPS (off)       |
| `bitrate`: `'64'`... `'320'`, `channels`, `trimStart`, `trimEnd` | audio                                             |
| `pageRange`: `'1-3, 5'`, `pdfA`: `true`                          | documents to PDF                                  |
| `ocr`: `true`, `ocrLanguage`                                     | scanned PDFs to Word or text                      |
| `compression`: `'light'`, `'balanced'`, `'strong'`               | PDF to a smaller PDF                              |
| `password`                                                       | a locked ZIP, 7Z or RAR (used once, never stored) |

The full list, and which settings apply to which conversion, is on the
[API page](https://converter.studio/developers). Settings that do not apply to a conversion are
ignored; a name the API does not know is refused (`BadRequestError`).

### Formats and account

```ts
for (const format of await client.formats()) {
  // no key needed
  console.log(format.id, '->', format.to.join(', '));
}

const [heic] = await client.formats({ from: 'heic' }); // what HEIC converts to
const account = await client.account();
console.log(account.plan, account.credits, account.renewsAt);
```

### Price limits

A conversion goes ahead on its own when it costs at most `maxCredits` (20 by default). A dearer
one waits for your go-ahead and costs nothing until then:

```ts
import { ConfirmationRequiredError } from 'converter-studio';

try {
  await client.convert('lecture.mkv', 'mp4', { maxCredits: 5 });
} catch (error) {
  if (!(error instanceof ConfirmationRequiredError)) throw error;
  console.log(`It costs ${error.credits} credits`);
  const conversion = await client.wait(await client.confirm(error.conversion));
}
```

`maxCredits: 0` only gets the price.

### Step by step

`convert()` is built from these, which you can call yourself:

```ts
const upload = await client.upload('scan.pdf'); // large files go in parts
let created = await client.createConversion({
  to: 'docx',
  uploadId: upload.id,
  options: { ocr: true },
});
created = await client.createConversion({ to: 'jpg', url: 'https://example.com/photo.heic' });
const now = await client.getConversion(created.id); // its status now
const later = await client.getConversion(created.id, { waitSeconds: 30 }); // the API holds the answer up to 30 s
const done = await client.wait(created, { timeout: 900_000 });
```

`wait()` returns a finished conversion or throws (see [Errors](#errors)). It lets the API hold each
status request until something changes, and pauses between answers that come back early (1
second, doubling up to 10).

### Callbacks and retries

```ts
const created = await client.createConversion({
  to: 'mp4',
  url: 'https://example.com/raw/clip.mov',
  callbackUrl: 'https://example.com/hooks/converter-studio?token=SECRET',
  idempotencyKey: 'clip-42',
});
```

- `callbackUrl`: an `https://` address on the public internet that Converter Studio POSTs to when
  the conversion waits for a go-ahead (`conversion.quoted`) and when it ends (`conversion.done`,
  `conversion.failed` or `conversion.canceled`). The body is
  `{ event, id, createdAt, conversion }`, with `Webhook-Id` and `Webhook-Timestamp` headers.
  Callbacks are not signed: keep the address secret, and check the conversion with your key
  before acting on one. `parseCallback()` reads the body:

  ```ts
  import { parseCallback } from 'converter-studio';

  // In a route handler that receives the POST (a web Request here):
  const event = parseCallback(await request.text()); // or the object your framework parsed
  if (event.event === 'conversion.done') {
    const conversion = await client.getConversion(event.conversion.id); // check it first
    await client.download(conversion, 'results/');
  }
  ```

  The same delivery can arrive more than once; `event.id` (the `Webhook-Id`) stays the same.

- `idempotencyKey`: sending the same request again with the same key (within 24 hours) returns the
  first conversion (`conversion.replayed` is `true`) instead of starting and charging a second
  one; the same key with a different request throws `ConflictError`. The client makes up a key for
  each `createConversion()` call and reuses it for its own retries, so pass your own when your code
  itself may repeat a request (a job queue retrying a task). With a local file, upload it once and
  repeat `createConversion({ uploadId })` with the same key.

### Cancelling

Every method takes an `AbortSignal`, which stops the request, the waiting and the retries; the
call then rejects with the signal's reason (an `AbortError`):

```ts
const conversion = await client.convert('talk.mov', 'mp4', {
  signal: AbortSignal.timeout(120_000),
});
```

The conversion itself goes on at Converter Studio; look it up later by its id if you need it.

### Errors

Every error derives from `ConverterStudioError`, and `error.message` is a sentence meant for
people (for API errors, the API's own message).

| Error                                                                                     | When                                                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `APIError`                                                                                | the API answered with an error: `.status`, `.code` (`notEnoughCredits`...), `.message`, `.params`         |
| `AuthenticationError` (401)                                                               | the API key does not work                                                                                 |
| `InsufficientCreditsError` (402)                                                          | not enough credits (`params`: `needed`, `balance`)                                                        |
| `FileTooLargeError` (413), `UnprocessableError` (422)                                     | the file is over the plan's limit; the file cannot be converted that way (`unsupportedConversion`)        |
| `BadRequestError`, `NotFoundError`, `ConflictError`, `GoneError`, `PermissionDeniedError` | 400, 404, 409, 410, 403                                                                                   |
| `RateLimitError` (429), `ServerError` (5xx)                                               | retried on their own first (`maxRetries`, 2 by default); `.retryAfter` in seconds                         |
| `ConversionFailedError`                                                                   | the conversion failed, expired or was canceled: `.code`, `.message`, `.conversion`; failures cost nothing |
| `ConfirmationRequiredError`                                                               | the price is over `maxCredits`: `.credits`, `.conversion`                                                 |
| `ConversionTimeoutError`                                                                  | not done within `timeout`; it may still finish (`.conversion.id`)                                         |
| `MissingApiKeyError`, `APIConnectionError`, `APITimeoutError`                             | no key; the API could not be reached, or did not answer in time                                           |

```ts
import { APIError, ConversionFailedError } from 'converter-studio';

try {
  await client.convert('broken.heic', 'jpg');
} catch (error) {
  if (error instanceof ConversionFailedError) console.log(error.code, error.message);
  else if (error instanceof APIError) console.log(error.status, error.code, error.message);
  else throw error;
}
```

Wrong arguments (no target format, both `url` and `uploadId`, bytes without a name) throw a
`TypeError` before anything is sent.

### Configuration

```ts
import { ConverterStudio } from 'converter-studio';

const client = new ConverterStudio({
  apiKey: 'cvs_live_...', // default: CONVERTER_STUDIO_API_KEY
  baseUrl: 'https://converter.studio/api', // default: CONVERTER_STUDIO_BASE_URL or this
  timeout: 60_000, // milliseconds to wait for each answer (uploads get more for their size)
  maxRetries: 2, // network errors, timeouts, 408, 429, 5xx
  fetch: myFetch, // your own fetch (a proxy, a test double); default: the runtime's
});
```

The API key is only sent to `baseUrl`; upload and download links carry their own tokens. The key
is kept in a private field, so it does not show when the client is logged.

### In a browser

An API key does not belong in a web page: anyone who opens the page can read it and spend the
account's credits. So in a browser the client **refuses an API key** with a clear error, unless you
pass `dangerouslyAllowBrowser: true`, which is meant for a key the page's own user typed in. Listing
formats needs no key. Paths and `download()` work only in Node.js, Deno and Bun; in a browser,
convert a `File` or `Blob` and use `downloadBytes()` or `conversion.downloadUrl`.

The API also answers web pages only from the origins Converter Studio has allowed (CORS). For your
own site, call Converter Studio from your server, where the key stays secret.

## Command line

The package installs `converter-studio` (`npx converter-studio` without installing):

```console
$ converter-studio convert talk.mov --to mp4 -O height=720 -O quality=balanced
[1/1] talk.mov -> mp4
  saved talk.mp4 (18.8 KB, 1 credit)
talk.mp4

$ converter-studio convert *.heic --to jpg --output-dir jpg/ -O keepMetadata=true
$ converter-studio convert https://example.com/report.docx --to pdf
$ converter-studio formats --from heic
$ converter-studio account
```

| Option                                  | What it does                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `-t`, `--to FORMAT`                     | the target format (`jpg`, `mp4`, `pdf`...)                                     |
| `-o`, `--output-dir DIR`                | where results go (default: the current folder)                                 |
| `-O`, `--option KEY=VALUE`              | a conversion setting, repeated for more; `KEY:=JSON` sends a JSON value        |
| `--max-credits N`                       | the most a conversion may cost to start on its own (default 20)                |
| `--timeout SECONDS`                     | how long to wait for each conversion (default 600)                             |
| `--overwrite`                           | replace existing files (otherwise the result gets `-1`, `-2`...)               |
| `--json`                                | print one JSON object per file (or the formats, or the account) to stdout      |
| `-q`, `--quiet`                         | print only errors                                                              |
| `--api-key-file PATH`, `--base-url URL` | the key from a file instead of `CONVERTER_STUDIO_API_KEY`; another API address |

Progress goes to stderr and the saved paths to stdout, one per line, so the output can be piped.
The API key is never printed. Exit codes: `0` all done, `1` a conversion or request failed, `2`
wrong usage, `3` no API key or a key that does not work, `4` not enough credits or a price over
`--max-credits`, `5` a conversion did not finish within `--timeout`, `130` interrupted. With
several files, the code is the first failure's, and the other files are still converted (except
after `3` or a lack of credits).

## Limits

- The largest file depends on the plan (`(await client.account()).maxFileBytes`). One request
  carries up to 95 MB; the client sends larger files in parts on its own.
- Audio and video length also depends on the plan (`maxMediaSeconds`).
- Results are kept for 6 hours, then deleted. A status request can wait up to 60 seconds.
- One file in, one file out: no merging or splitting of PDFs.

## Privacy

Your files are sent to Converter Studio (converter.studio) to be converted. Uploaded files are
deleted as soon as they are converted, and results 6 hours later. Each request also says which
client sent it (`X-Converter-Studio-Client: node/<version>`), for usage statistics only. See the
[privacy policy](https://converter.studio/privacy) and the [terms](https://converter.studio/terms).

## Links

- Converter Studio: <https://converter.studio>
- API documentation: <https://converter.studio/developers>
- Pricing: <https://converter.studio/pricing>
- Source code and issues: <https://github.com/tariksucu/converter-studio-js>
- Changelog: <https://github.com/tariksucu/converter-studio-js/blob/main/CHANGELOG.md>
- Support: <support@converter.studio>

MIT licensed. © Converter Studio.
