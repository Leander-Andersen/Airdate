/**
 * Low-level authenticated Graph transport: token attachment, retry policy and
 * error normalisation. `calendar.ts` and `batch.ts` both sit on top of this.
 */

import type { Logger } from '../log.js';
import type { TokenProvider } from './auth.js';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/** Never sleep longer than this on a Retry-After; the cron will come round again. */
const MAX_BACKOFF_MS = 20_000;

export interface GraphContext {
  baseUrl: string;
  tokens: TokenProvider;
  fetchImpl: typeof fetch;
  log: Logger;
  /** Overridable so tests do not actually sleep. */
  sleep: (ms: number) => Promise<void>;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** A misconfiguration rather than a blip: worth flagging distinctly. */
  get isConfigurationFault(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGraphContext(
  tokens: TokenProvider,
  log: Logger,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  sleep: (ms: number) => Promise<void> = defaultSleep,
): GraphContext {
  return { baseUrl: GRAPH_BASE_URL, tokens, fetchImpl, log, sleep };
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504 || status === 500 || status === 502;
}

/**
 * Honour `Retry-After` when Graph sends one, otherwise back off exponentially.
 * Graph's throttling guidance is explicit that the header is authoritative.
 */
export function backoffDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), MAX_BACKOFF_MS);
    }
  }

  // Jitter so a batch of parallel chunks does not retry in lockstep.
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(exponential + Math.floor(Math.random() * 250), MAX_BACKOFF_MS);
}

/** Pull the human-readable part out of Graph's error envelope. */
export function describeGraphError(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};

  const error = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return {};

  const record = error as Record<string, unknown>;
  const result: { code?: string; message?: string } = {};
  if (typeof record['code'] === 'string') result.code = record['code'];
  if (typeof record['message'] === 'string') result.message = record['message'];
  return result;
}

export interface GraphResponse {
  status: number;
  body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const text = await response.text().catch(() => '');
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

/**
 * Perform a single authenticated Graph call.
 *
 * Retries throttling and transient server errors up to three attempts. A 401
 * additionally clears the cached token once, to cover a credential rotated or
 * revoked mid-cache-window.
 */
export async function graphRequest(
  ctx: GraphContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<GraphResponse> {
  let refreshedOnce = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await ctx.tokens.get();

    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      ctx.log.warn('Graph returned 401; refreshing the cached token and retrying once');
      await ctx.tokens.invalidate();
      continue;
    }

    if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
      const delay = backoffDelayMs(attempt, response.headers.get('retry-after'));
      ctx.log.warn('Graph call throttled or unavailable; backing off', {
        method,
        path,
        status: response.status,
        attempt,
        delayMs: delay,
      });
      await ctx.sleep(delay);
      continue;
    }

    const parsed = await readJson(response);

    if (!response.ok) {
      const { code, message } = describeGraphError(parsed);
      throw new GraphError(
        `Graph ${method} ${path} failed with ${response.status}${message ? `: ${message}` : ''}`,
        response.status,
        code,
        message,
      );
    }

    return { status: response.status, body: parsed };
  }

  throw new GraphError(
    `Graph ${method} ${path} still failing after ${MAX_ATTEMPTS} attempts`,
    503,
  );
}

/**
 * Run tasks with a ceiling on how many are in flight at once.
 *
 * Workers can hold plenty of concurrent fetches, but Graph throttles per app —
 * so the useful limit here is politeness towards Graph, not local capacity.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
