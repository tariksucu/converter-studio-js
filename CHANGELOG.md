# Changelog

All notable changes to this package are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/).

## 1.0.1 - unreleased

- README: a note in "Command line" on the two commands named `converter-studio`. This package's
  uploads every file to converter.studio; the desktop app's converts on the computer and uses the
  cloud only with `--cloud`. The one first on `PATH` runs; `npx converter-studio` always runs
  this package's. No change in behaviour.

## 1.0.0 - 2026-11-23

The first release.

- `ConverterStudio`: convert a local file, a `Blob` or `File`, bytes, a stream or a link with any
  of the API's settings; wait with long polling and a back-off; save, stream or read the result;
  list formats; read the account's plan and credits. Node.js 22.12 or later, Deno, Bun and
  browsers (where an API key is refused unless allowed).
- Uploads in parts for files over 95 MB, read from disk as they are sent; retries for network
  errors, timeouts, 408, 429 and 5xx answers; an `Idempotency-Key` on every conversion;
  `callbackUrl` and `parseCallback()`; `AbortSignal` on every call; typed errors with the API's
  code and message.
- The `converter-studio` command: `convert` (several files, `--option`, `--output-dir`), `formats`
  and `account`, with exit codes for scripts.
