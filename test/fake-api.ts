// A small stand-in for the Converter Studio API, served through a `fetch` function.

import type { FetchLike } from '../src/index.ts';

export const BASE = 'https://api.test/api';
export const KEY = 'cvs_live_test_key_0123456789';

export interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** An answer to give before the normal one: a response, an error to throw, or a function. */
export type Queued =
  | Response
  | Error
  | ((request: Recorded, signal: AbortSignal | undefined) => Response | Promise<Response>);

interface Job {
  id: string;
  to: string;
  name: string;
  size: number;
  statuses: string[];
  credits: number;
  maxCredits: number | null;
  error: Record<string, unknown> | null;
  output: Uint8Array;
  outputName: string | null;
}

const text = new TextDecoder();

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  params?: Record<string, string | number>,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message, ...(params ? { params } : {}) } }, headers);
}

/** What `fetch` throws when the connection fails. */
export function networkError(code = 'ECONNRESET'): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });
}

/** An answer that never comes, until the request is aborted. */
export function hang(_request: Recorded, signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason as Error);
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class FakeAPI {
  statuses: string[] = ['processing', 'done'];
  output: Uint8Array = new TextEncoder().encode('RESULT');
  outputName: string | null = null;
  credits = 1;
  error: Record<string, unknown> | null = null;
  readonly requests: Recorded[] = [];
  readonly uploads = new Map<string, { name: string; size: number | null; data: Uint8Array }>();
  readonly jobs = new Map<string, Job>();
  readonly queue = new Map<string, Queued[]>();
  readonly idempotency = new Map<string, [string, string]>();
  /** Called with each long poll's `wait`, before it is answered (to move a fake clock). */
  onLongPoll: ((seconds: number) => void) | null = null;
  private counter = 0;

  readonly fetch: FetchLike = async (input, init = {}) => {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const request: Recorded = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: new Headers(init.headers),
      body: await bodyBytes(init.body),
    };
    this.requests.push(request);
    const queued = this.queue.get(request.url.pathname);
    const answer = queued?.shift();
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (typeof answer === 'function') return answer(request, signal);
    return this.route(request);
  };

  /** Answers to give first for requests to `path` (the URL's path, with `/api`). */
  push(path: string, ...answers: Queued[]): void {
    this.queue.set(path, [...(this.queue.get(path) ?? []), ...answers]);
  }

  of(method: string, path: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.url.pathname === path);
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter).padStart(8, '0')}`;
  }

  view(job: Job): Record<string, unknown> {
    const status = job.statuses[0] ?? 'failed';
    const done = status === 'done';
    const stem = job.name.replace(/\.[^.]*$/, '');
    return {
      id: job.id,
      status,
      from: job.name.split('.').pop()?.toLowerCase() ?? null,
      to: job.to,
      inputName: job.name,
      inputSize: job.size,
      credits: job.credits,
      maxCredits: job.maxCredits,
      progress: done ? 1 : null,
      outputName: job.outputName ?? `${stem}.${job.to}`,
      outputSize: done ? job.output.byteLength : null,
      downloadUrl: done ? `${BASE}/jobs/${job.id}/download?token=tok_${job.id}` : null,
      expiresAt: '2026-11-23T07:00:00.000Z',
      error: status === 'failed' ? job.error : null,
      next: done ? 'Done.' : 'Check again.',
    };
  }

  private route(request: Recorded): Response {
    const path = request.url.pathname.replace(/^\/api/, '');
    const { method } = request;
    if (method === 'GET' && path === '/v1/formats') {
      const formats = [
        {
          id: 'heic',
          name: 'HEIC',
          category: 'image',
          extensions: ['heic', 'heif'],
          to: ['jpg', 'png'],
        },
        { id: 'mov', name: 'QuickTime', category: 'video', extensions: ['mov'], to: ['mp4'] },
      ];
      const wanted = request.url.searchParams.get('from');
      if (wanted && !formats.some((f) => f.id === wanted))
        return errorResponse(400, 'invalidRequest', "Something about that request wasn't right.");
      return jsonResponse(200, { formats: formats.filter((f) => !wanted || f.id === wanted) });
    }
    const open = path.startsWith('/v1/uploads/') || path.startsWith('/jobs/');
    if (!open && request.headers.get('authorization') !== `Bearer ${KEY}`)
      return errorResponse(401, 'invalidApiKey', 'This API key does not work.');
    if (method === 'GET' && path === '/v1/account')
      return jsonResponse(200, {
        email: 'dev@example.com',
        plan: 'pro',
        allApps: true,
        credits: 1099,
        allowance: { used: 1, limit: 1100, per: 'month' },
        packs: 0,
        renewsAt: '2026-12-22T01:16:48.716Z',
        maxFileBytes: 1073741824,
        maxMediaSeconds: 7200,
        wallet: { balanceMicros: 1500000, pays: true },
      });
    if (method === 'POST' && path === '/v1/uploads') {
      const data = JSON.parse(text.decode(request.body)) as { fileName: string; size?: number };
      const id = this.nextId('up');
      this.uploads.set(id, {
        name: data.fileName,
        size: data.size ?? null,
        data: new Uint8Array(),
      });
      return jsonResponse(201, {
        id,
        uploadUrl: `${BASE}/v1/uploads/${id}?token=tok_${id}`,
        method: 'PUT',
        maxBytes: 1073741824,
        partBytes: 95 * 1024 * 1024,
        expiresAt: '2026-11-23T02:00:00.000Z',
        curl: 'curl ...',
      });
    }
    if (method === 'PUT' && path.startsWith('/v1/uploads/')) {
      const id = path.split('/').pop() ?? '';
      const upload = this.uploads.get(id);
      if (!upload || request.url.searchParams.get('token') !== `tok_${id}`)
        return errorResponse(404, 'notFound', "We couldn't find that conversion.");
      const offset = request.headers.get('upload-offset');
      if (offset === null) {
        upload.data = request.body;
      } else {
        const joined = new Uint8Array(Number(offset) + request.body.byteLength);
        joined.set(upload.data.subarray(0, Number(offset)));
        joined.set(request.body, Number(offset));
        upload.data = joined;
      }
      return jsonResponse(200, { id, status: 'ready' });
    }
    if (method === 'POST' && path === '/v1/conversions')
      return this.create(request, JSON.parse(text.decode(request.body)) as Record<string, unknown>);
    if (path.startsWith('/v1/conversions/')) {
      const parts = path.split('/');
      const job = this.jobs.get(parts[3] ?? '');
      if (!job) return errorResponse(404, 'notFound', "We couldn't find that conversion.");
      if (method === 'POST' && parts.at(-1) === 'confirm') {
        job.statuses = ['queued', 'done'];
        return jsonResponse(200, this.view(job));
      }
      const wait = request.url.searchParams.get('wait');
      if (wait) this.onLongPoll?.(Number(wait));
      const view = this.view(job);
      if (job.statuses.length > 1) job.statuses.shift();
      return jsonResponse(200, view);
    }
    if (method === 'GET' && path.startsWith('/jobs/')) {
      const job = this.jobs.get(path.split('/')[2] ?? '');
      if (!job || request.url.searchParams.get('token') !== `tok_${job.id}`)
        return jsonResponse(404, { error: 'notFound' });
      return new Response(job.output as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    return jsonResponse(404, { error: 'notFound' });
  }

  private create(request: Recorded, data: Record<string, unknown>): Response {
    const key = request.headers.get('idempotency-key');
    const fingerprint = JSON.stringify(data);
    const seen = key === null ? undefined : this.idempotency.get(key);
    if (seen) {
      const [id, print] = seen;
      if (print !== fingerprint)
        return errorResponse(409, 'idempotencyKeyReused', 'This Idempotency-Key was already used.');
      const job = this.jobs.get(id);
      return jsonResponse(200, job ? this.view(job) : {}, { 'Idempotent-Replayed': 'true' });
    }
    let id: string;
    let name: string;
    let size: number;
    if (typeof data['uploadId'] === 'string') {
      const upload = this.uploads.get(data['uploadId']);
      if (!upload) return errorResponse(404, 'notFound', "We couldn't find that conversion.");
      this.uploads.delete(data['uploadId']);
      id = data['uploadId'];
      name = upload.name;
      size = upload.data.byteLength;
    } else {
      id = this.nextId('ln');
      name = String(data['url']).split('/').pop() || 'file';
      size = 0;
    }
    const maxCredits = typeof data['maxCredits'] === 'number' ? data['maxCredits'] : 20;
    const job: Job = {
      id,
      to: String(data['to']),
      name,
      size,
      statuses: this.credits > maxCredits ? ['quoted'] : [...this.statuses],
      credits: this.credits,
      maxCredits,
      error: this.error,
      output: this.output,
      outputName: this.outputName,
    };
    this.jobs.set(id, job);
    if (key !== null) this.idempotency.set(key, [id, fingerprint]);
    return jsonResponse(201, {
      ...this.view(job),
      status: typeof data['url'] === 'string' ? 'fetching' : 'queued',
    });
  }
}
