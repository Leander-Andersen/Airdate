/**
 * Graph `$batch` assembly and response handling.
 *
 * A first sync can be 100+ creates. Individually that is 100+ round trips, which
 * is slow and a reliable way to get throttled; batched it is six requests.
 */

import {
  backoffDelayMs,
  graphRequest,
  isRetryableStatus,
  mapWithConcurrency,
  type GraphContext,
} from './request.js';

/** Graph's hard limit on sub-requests per $batch. */
export const MAX_BATCH_SIZE = 20;
/** Concurrent batches in flight. Bounded out of politeness to Graph's throttler. */
const BATCH_CONCURRENCY = 4;
const MAX_BATCH_ATTEMPTS = 3;

export interface BatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path relative to /v1.0, e.g. `/users/me/events/AAA`. */
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface BatchSubResponse {
  id: string;
  status: number;
  body: unknown;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseSubResponses(payload: unknown): Map<string, BatchSubResponse> {
  const byId = new Map<string, BatchSubResponse>();

  if (typeof payload !== 'object' || payload === null) return byId;
  const responses = (payload as Record<string, unknown>)['responses'];
  if (!Array.isArray(responses)) return byId;

  for (const entry of responses) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const id = record['id'];
    const status = record['status'];
    if (typeof id !== 'string' || typeof status !== 'number') continue;

    byId.set(id, { id, status, body: record['body'] ?? null });
  }

  return byId;
}

/** The largest Retry-After advertised by any throttled sub-response. */
function retryAfterFromSubResponses(payload: unknown, ids: Set<string>): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const responses = (payload as Record<string, unknown>)['responses'];
  if (!Array.isArray(responses)) return null;

  let longest: number | null = null;

  for (const entry of responses) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || !ids.has(record['id'])) continue;

    const headers = record['headers'];
    if (typeof headers !== 'object' || headers === null) continue;

    const value = (headers as Record<string, unknown>)['Retry-After'];
    const seconds = Number(value);
    if (Number.isFinite(seconds) && (longest === null || seconds > longest)) {
      longest = seconds;
    }
  }

  return longest === null ? null : String(longest);
}

/**
 * Send one chunk, retrying only the sub-requests that came back throttled or
 * transiently failed. Sub-responses are matched by `id` — Graph explicitly does
 * not guarantee they come back in request order.
 */
async function executeChunk(
  ctx: GraphContext,
  requests: BatchRequest[],
): Promise<BatchSubResponse[]> {
  const settled = new Map<string, BatchSubResponse>();
  let outstanding = requests;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS && outstanding.length > 0; attempt++) {
    const { body } = await graphRequest(ctx, 'POST', '/$batch', {
      requests: outstanding.map((request) => ({
        id: request.id,
        method: request.method,
        url: request.url,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.body !== undefined || request.headers
          ? {
              headers: {
                ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...request.headers,
              },
            }
          : {}),
      })),
    });

    const received = parseSubResponses(body);
    const retryable: BatchRequest[] = [];

    for (const request of outstanding) {
      const response = received.get(request.id);

      if (!response) {
        // Graph dropped a sub-response entirely. Treat as a retryable gap.
        retryable.push(request);
        continue;
      }

      if (isRetryableStatus(response.status) && attempt < MAX_BATCH_ATTEMPTS) {
        retryable.push(request);
        continue;
      }

      settled.set(request.id, response);
    }

    if (retryable.length === 0) break;

    const retryIds = new Set(retryable.map((request) => request.id));
    const delay = backoffDelayMs(attempt, retryAfterFromSubResponses(body, retryIds));

    ctx.log.warn('Retrying throttled batch sub-requests', {
      count: retryable.length,
      attempt,
      delayMs: delay,
    });

    await ctx.sleep(delay);
    outstanding = retryable;
  }

  // Anything still unsettled exhausted its attempts.
  for (const request of outstanding) {
    if (!settled.has(request.id)) {
      settled.set(request.id, {
        id: request.id,
        status: 503,
        body: { error: { code: 'batchRetriesExhausted' } },
      });
    }
  }

  return requests.map(
    (request) =>
      settled.get(request.id) ?? {
        id: request.id,
        status: 503,
        body: { error: { code: 'missingSubResponse' } },
      },
  );
}

/**
 * Execute every request, chunked to Graph's 20-per-batch limit.
 *
 * A sub-request failure never fails the whole run: results come back per id and
 * the caller decides what to record and what to log.
 */
export async function executeBatch(
  ctx: GraphContext,
  requests: readonly BatchRequest[],
): Promise<BatchSubResponse[]> {
  if (requests.length === 0) return [];

  const chunks = chunk(requests, MAX_BATCH_SIZE);
  ctx.log.debug('Dispatching Graph batches', {
    requests: requests.length,
    batches: chunks.length,
  });

  const perChunk = await mapWithConcurrency(chunks, BATCH_CONCURRENCY, (batch) =>
    executeChunk(ctx, batch),
  );

  return perChunk.flat();
}
