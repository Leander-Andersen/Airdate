/**
 * Source adapter for the ICS feed.
 *
 * Two shapes are supported:
 *   - a public tokenised URL (TVmaze), where the token is a query parameter
 *   - a private origin behind Cloudflare Access (Sonarr via a tunnel), where a
 *     service token is presented as request headers
 *
 * Both carry credentials, so the assembled URL is never logged — only the origin
 * and path, via `describeIcsSource`.
 */

import { describeIcsSource, type Config } from '../config.js';
import type { Logger } from '../log.js';

/** A TV feed is tens of KB. Anything past this is a broken or hostile upstream. */
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

export class IcsFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'IcsFetchError';
  }
}

/** Assemble the request URL. Returns a URL carrying credentials — do not log it. */
export function buildFeedUrl(config: Config): URL {
  const url = new URL(config.ics.baseUrl);
  if (config.ics.token) {
    url.searchParams.set('token', config.ics.token);
  }
  return url;
}

function buildHeaders(config: Config): Headers {
  const headers = new Headers({
    Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
    'User-Agent': 'Airdate/0.1 (+https://github.com/Leander-Andersen/Airdate)',
  });

  if (config.ics.accessClientId && config.ics.accessClientSecret) {
    headers.set('CF-Access-Client-Id', config.ics.accessClientId);
    headers.set('CF-Access-Client-Secret', config.ics.accessClientSecret);
  }

  return headers;
}

/**
 * Read the body with a hard byte ceiling, so a runaway response cannot exhaust
 * the isolate's memory before we ever get to parse it.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new IcsFetchError(`Feed declares ${declared} bytes, over the ${maxBytes} byte ceiling`);
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new IcsFetchError(`Feed exceeded the ${maxBytes} byte ceiling mid-stream`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8').decode(merged);
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch the raw ICS document.
 *
 * Throws on anything other than a 2xx. The caller treats a throw as "leave the
 * calendar alone" — a failed fetch must never be mistaken for an empty feed.
 */
export async function fetchIcs(
  config: Config,
  log: Logger,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<string> {
  const url = buildFeedUrl(config);
  const headers = buildHeaders(config);
  const source = describeIcsSource(config);

  let lastError: Error = new IcsFetchError('Feed fetch never ran');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // The whole point of this Worker is bypassing someone else's cache.
        cache: 'no-store',
      });

      if (!response.ok) {
        // Cloudflare Access answers an unauthenticated request with an HTML
        // login page, so a 302/403 here usually means a bad service token.
        const hint =
          response.status === 403 || response.status === 401
            ? ' (check ICS_TOKEN, or the CF Access service token if the source is tunnelled)'
            : '';

        const error = new IcsFetchError(
          `Feed ${source} returned ${response.status}${hint}`,
          response.status,
        );

        if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = error;
          const backoffMs = 500 * 2 ** (attempt - 1);
          log.warn('Feed fetch failed; retrying', {
            source,
            status: response.status,
            attempt,
            backoffMs,
          });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        throw error;
      }

      const text = await readBounded(response, MAX_FEED_BYTES);

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/text\/calendar|text\/plain|application\/octet-stream/i.test(contentType)) {
        // Not fatal — some hosts mislabel — but a strong hint that a proxy or
        // login page answered instead of the feed.
        log.warn('Feed returned an unexpected content type', { source, contentType });
      }

      log.debug('Feed fetched', { source, bytes: text.length, attempt });
      return text;
    } catch (error) {
      const normalized =
        error instanceof IcsFetchError
          ? error
          : new IcsFetchError(
              error instanceof Error
                ? `Feed ${source} request failed: ${error.message}`
                : `Feed ${source} request failed`,
            );

      // A non-retryable status has already exhausted its chances above.
      if (normalized.status !== undefined && !isRetryable(normalized.status)) throw normalized;
      if (attempt >= MAX_ATTEMPTS) throw normalized;

      lastError = normalized;
      const backoffMs = 500 * 2 ** (attempt - 1);
      log.warn('Feed fetch errored; retrying', { source, attempt, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}
