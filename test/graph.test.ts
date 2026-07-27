import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { GraphCalendarApi } from '../src/graph/api.js';
import { TokenProvider } from '../src/graph/auth.js';
import { chunk, executeBatch, MAX_BATCH_SIZE, type BatchRequest } from '../src/graph/batch.js';
import { CalendarResolver } from '../src/graph/calendar.js';
import { buildCreatePayload, buildUpdatePayload } from '../src/graph/events.js';
import { backoffDelayMs, GRAPH_BASE_URL, type GraphContext } from '../src/graph/request.js';
import { hashEvent, type NormalizedEvent } from '../src/ics/parse.js';
import { silentLogger } from '../src/log.js';
import type { Operation } from '../src/sync.js';

const CONFIG: Config = {
  feedId: 'default',
  ics: { baseUrl: 'https://feed.invalid/ical' },
  graph: {
    tenantId: 'tenant-id',
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    targetUpn: 'user@example.com',
  },
  calendarName: 'TV',
  eventCategory: 'TV',
  defaultDurationMinutes: 30,
  displayTimeZone: 'Europe/Oslo',
  stateRetentionDays: 30,
  recentLimit: 100,
  debug: false,
};

async function makeEvent(
  uid: string,
  summary: string,
  startIso: string,
  endIso: string,
  extra: Partial<Pick<NormalizedEvent, 'description' | 'url' | 'isAllDay'>> = {},
): Promise<NormalizedEvent> {
  const fields = {
    summary,
    start: new Date(startIso),
    end: new Date(endIso),
    isAllDay: extra.isAllDay ?? false,
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    ...(extra.url !== undefined ? { url: extra.url } : {}),
  };
  return { uid, ...fields, hash: await hashEvent(fields) };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stand-in driven by a queue of responder functions. */
function mockFetch(responders: Array<(call: RecordedCall) => Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
    calls.push(call);

    const responder = responders[Math.min(index++, responders.length - 1)];
    if (!responder) throw new Error('mock fetch ran out of responders');
    return responder(call);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function contextWith(fetchImpl: typeof fetch, kvSuffix: string): GraphContext {
  const tokens = new TokenProvider(
    env.TV_SYNC_STATE,
    { ...CONFIG.graph, clientId: `client-${kvSuffix}` },
    silentLogger,
    (async () =>
      jsonResponse({ access_token: 'test-token', expires_in: 3600 })) as unknown as typeof fetch,
  );

  return {
    baseUrl: GRAPH_BASE_URL,
    tokens,
    fetchImpl,
    log: silentLogger,
    sleep: async () => {}, // Tests must not actually wait out a backoff.
  };
}

describe('chunk', () => {
  it('splits at the Graph batch limit', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const chunks = chunk(items, MAX_BATCH_SIZE);

    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(chunks.flat()).toEqual(items);
  });

  it('returns nothing for an empty input', () => {
    expect(chunk([], MAX_BATCH_SIZE)).toEqual([]);
  });
});

describe('executeBatch', () => {
  const requests = (count: number): BatchRequest[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `op-${i}`,
      method: 'DELETE' as const,
      url: `/users/u/events/e${i}`,
    }));

  it('chunks 45 requests into three batches', async () => {
    const { fetchImpl, calls } = mockFetch([
      (call) => {
        const body = call.body as { requests: Array<{ id: string }> };
        return jsonResponse({
          responses: body.requests.map((r) => ({ id: r.id, status: 204, body: null })),
        });
      },
    ]);

    const ctx = contextWith(fetchImpl, 'chunking');
    const results = await executeBatch(ctx, requests(45));

    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(45);
    expect(results.every((r) => r.status === 204)).toBe(true);
  });

  it('matches sub-responses by id, not by array position', async () => {
    const { fetchImpl } = mockFetch([
      (call) => {
        const body = call.body as { requests: Array<{ id: string }> };
        // Graph does not guarantee ordering — return them reversed, with a
        // distinguishable status per id.
        const responses = body.requests
          .map((r) => ({ id: r.id, status: r.id === 'op-1' ? 404 : 204, body: null }))
          .reverse();
        return jsonResponse({ responses });
      },
    ]);

    const ctx = contextWith(fetchImpl, 'ordering');
    const results = await executeBatch(ctx, requests(3));

    expect(results.map((r) => r.id)).toEqual(['op-0', 'op-1', 'op-2']);
    expect(results.find((r) => r.id === 'op-1')?.status).toBe(404);
    expect(results.find((r) => r.id === 'op-0')?.status).toBe(204);
  });

  it('(8) retries a throttled sub-request and eventually succeeds', async () => {
    let round = 0;

    const { fetchImpl, calls } = mockFetch([
      (call) => {
        round++;
        const body = call.body as { requests: Array<{ id: string }> };

        if (round === 1) {
          // op-1 is throttled; the rest succeed first time.
          return jsonResponse({
            responses: body.requests.map((r) =>
              r.id === 'op-1'
                ? { id: r.id, status: 429, headers: { 'Retry-After': '1' }, body: null }
                : { id: r.id, status: 204, body: null },
            ),
          });
        }

        return jsonResponse({
          responses: body.requests.map((r) => ({ id: r.id, status: 204, body: null })),
        });
      },
    ]);

    const ctx = contextWith(fetchImpl, 'throttle');
    const results = await executeBatch(ctx, requests(3));

    // Second call carries only the throttled sub-request.
    expect(calls).toHaveLength(2);
    expect((calls[1]?.body as { requests: unknown[] }).requests).toHaveLength(1);
    expect(results.every((r) => r.status === 204)).toBe(true);
  });

  it('gives up after three attempts and reports the failure per sub-request', async () => {
    const { fetchImpl, calls } = mockFetch([
      (call) => {
        const body = call.body as { requests: Array<{ id: string }> };
        return jsonResponse({
          responses: body.requests.map((r) => ({ id: r.id, status: 429, body: null })),
        });
      },
    ]);

    const ctx = contextWith(fetchImpl, 'exhausted');
    const results = await executeBatch(ctx, requests(2));

    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 429 || r.status === 503)).toBe(true);
  });

  it('synthesises a failure when Graph omits a sub-response', async () => {
    const { fetchImpl } = mockFetch([
      () => jsonResponse({ responses: [{ id: 'op-0', status: 204, body: null }] }),
    ]);

    const ctx = contextWith(fetchImpl, 'missing');
    const results = await executeBatch(ctx, requests(2));

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === 'op-1')?.status).toBe(503);
  });

  it('does nothing at all for an empty operation list', async () => {
    const { fetchImpl, calls } = mockFetch([() => jsonResponse({ responses: [] })]);

    const ctx = contextWith(fetchImpl, 'empty');
    expect(await executeBatch(ctx, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('backoffDelayMs', () => {
  it('honours a numeric Retry-After in seconds', () => {
    expect(backoffDelayMs(1, '3')).toBe(3000);
  });

  it('caps a very long Retry-After', () => {
    expect(backoffDelayMs(1, '600')).toBe(20_000);
  });

  it('falls back to jittered exponential backoff', () => {
    const first = backoffDelayMs(1, null);
    const third = backoffDelayMs(3, null);

    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThan(1000);
    expect(third).toBeGreaterThanOrEqual(2000);
  });
});

describe('event payloads', () => {
  it('sets showAs free and disables reminders', async () => {
    const event = await makeEvent(
      'ep',
      'Severance - S02E05',
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
    );
    const payload = buildCreatePayload(event, CONFIG);

    // Without these a busy week blocks out free/busy and fires a pile of alerts.
    expect(payload.showAs).toBe('free');
    expect(payload.isReminderOn).toBe(false);
    expect(payload.categories).toEqual(['TV']);
  });

  it('renders instants as wall time in the display zone', async () => {
    const event = await makeEvent(
      'ep',
      'Show',
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
    );
    const payload = buildCreatePayload(event, CONFIG);

    // July in Oslo is CEST (+02:00).
    expect(payload.start).toEqual({ dateTime: '2026-07-30T21:00:00', timeZone: 'Europe/Oslo' });
    expect(payload.end).toEqual({ dateTime: '2026-07-30T21:45:00', timeZone: 'Europe/Oslo' });
    expect(payload.isAllDay).toBe(false);
  });

  it('keeps all-day events midnight-aligned with an exclusive end', async () => {
    const event = await makeEvent(
      'ep',
      'Slow Horses - S05E01',
      '2026-08-02T00:00:00Z',
      '2026-08-03T00:00:00Z',
      { isAllDay: true },
    );
    const payload = buildCreatePayload(event, CONFIG);

    expect(payload.isAllDay).toBe(true);
    expect(payload.start.dateTime).toBe('2026-08-02T00:00:00');
    // The day after the last day, as Graph requires.
    expect(payload.end.dateTime).toBe('2026-08-03T00:00:00');
  });

  it('sends the body as text so feed content cannot inject markup', async () => {
    const event = await makeEvent(
      'ep',
      'Show',
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
      { description: '<script>alert(1)</script> synopsis', url: 'https://example.invalid/e/1' },
    );
    const payload = buildCreatePayload(event, CONFIG);

    expect(payload.body.contentType).toBe('text');
    expect(payload.body.content).toContain('<script>');
    expect(payload.body.content).toContain('https://example.invalid/e/1');
  });

  it('does not repeat the URL when the description already contains it', async () => {
    const url = 'https://example.invalid/e/1';
    const event = await makeEvent(
      'ep',
      'Show',
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
      { description: `Synopsis\n\n${url}`, url },
    );

    const content = buildCreatePayload(event, CONFIG).body.content;
    expect(content.match(/example\.invalid/g)).toHaveLength(1);
  });

  it('truncates an over-long subject to Graph limits', async () => {
    const event = await makeEvent(
      'ep',
      'x'.repeat(400),
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
    );

    expect(buildCreatePayload(event, CONFIG).subject).toHaveLength(255);
  });

  it('carries transactionId on create but not on update', async () => {
    const event = await makeEvent(
      'ep',
      'Show',
      '2026-07-30T19:00:00Z',
      '2026-07-30T19:45:00Z',
    );

    expect(buildCreatePayload(event, CONFIG).transactionId).toBe(event.hash);
    expect('transactionId' in buildUpdatePayload(event, CONFIG)).toBe(false);
  });
});

describe('CalendarResolver', () => {
  it('reuses a stored id once verified', async () => {
    const { fetchImpl, calls } = mockFetch([() => jsonResponse({ id: 'cal-stored' })]);

    const resolver = new CalendarResolver(
      contextWith(fetchImpl, 'verify'),
      CONFIG.graph,
      'TV',
      silentLogger,
    );

    expect(await resolver.resolve('cal-stored')).toBe('cal-stored');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('re-resolves by name when the stored id has gone', async () => {
    const { fetchImpl, calls } = mockFetch([
      () => jsonResponse({ error: { code: 'ErrorItemNotFound' } }, 404),
      () => jsonResponse({ value: [{ id: 'cal-found', name: 'TV' }] }),
    ]);

    const resolver = new CalendarResolver(
      contextWith(fetchImpl, 'requery'),
      CONFIG.graph,
      'TV',
      silentLogger,
    );

    expect(await resolver.resolve('cal-dead')).toBe('cal-found');
    expect(calls).toHaveLength(2);
  });

  it('creates the calendar when no name matches', async () => {
    const { fetchImpl, calls } = mockFetch([
      () => jsonResponse({ value: [{ id: 'other', name: 'Birthdays' }] }),
      () => jsonResponse({ id: 'cal-new', name: 'TV' }, 201),
    ]);

    const resolver = new CalendarResolver(
      contextWith(fetchImpl, 'create'),
      CONFIG.graph,
      'TV',
      silentLogger,
    );

    expect(await resolver.resolve(null)).toBe('cal-new');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toEqual({ name: 'TV' });
  });
});

describe('GraphCalendarApi.apply', () => {
  it('maps operations to the right verbs and returns per-uid results', async () => {
    const event = await makeEvent(
      'uid-new',
      'New Show',
      '2026-08-01T19:00:00Z',
      '2026-08-01T19:30:00Z',
    );
    const changed = await makeEvent(
      'uid-changed',
      'Moved Show',
      '2026-08-02T19:00:00Z',
      '2026-08-02T19:30:00Z',
    );

    const operations: Operation[] = [
      { kind: 'create', uid: 'uid-new', event },
      { kind: 'update', uid: 'uid-changed', eventId: 'event-abc', event: changed },
      { kind: 'delete', uid: 'uid-gone', eventId: 'event-xyz' },
    ];

    const { fetchImpl, calls } = mockFetch([
      (call) => {
        const body = call.body as {
          requests: Array<{ id: string; method: string; url: string }>;
        };
        return jsonResponse({
          responses: body.requests.map((r) => ({
            id: r.id,
            status: r.method === 'POST' ? 201 : 204,
            body: r.method === 'POST' ? { id: 'created-event-1' } : null,
          })),
        });
      },
    ]);

    const api = new GraphCalendarApi(contextWith(fetchImpl, 'apply'), CONFIG, silentLogger);
    const results = await api.apply('cal-1', operations);

    const sent = (calls[0]?.body as { requests: Array<{ method: string; url: string }> }).requests;
    expect(sent.map((r) => r.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(sent[0]?.url).toBe('/users/user%40example.com/calendars/cal-1/events');
    expect(sent[1]?.url).toBe('/users/user%40example.com/events/event-abc');

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ uid: 'uid-new', ok: true, eventId: 'created-event-1' });
    expect(results[1]).toMatchObject({ uid: 'uid-changed', ok: true });
    expect(results[2]).toMatchObject({ uid: 'uid-gone', ok: true });
  });

  it('reports a 404 on delete without marking it a hard failure upstream', async () => {
    const { fetchImpl } = mockFetch([
      (call) => {
        const body = call.body as { requests: Array<{ id: string }> };
        return jsonResponse({
          responses: body.requests.map((r) => ({
            id: r.id,
            status: 404,
            body: { error: { code: 'ErrorItemNotFound', message: 'gone' } },
          })),
        });
      },
    ]);

    const api = new GraphCalendarApi(contextWith(fetchImpl, 'gone'), CONFIG, silentLogger);
    const results = await api.apply('cal-1', [
      { kind: 'delete', uid: 'uid-gone', eventId: 'event-xyz' },
    ]);

    expect(results[0]).toMatchObject({ uid: 'uid-gone', ok: false, status: 404 });
  });

  it('treats a 2xx create with no id as a failure so it gets retried', async () => {
    const event = await makeEvent('uid', 'Show', '2026-08-01T19:00:00Z', '2026-08-01T19:30:00Z');

    const { fetchImpl } = mockFetch([
      (call) => {
        const body = call.body as { requests: Array<{ id: string }> };
        return jsonResponse({
          responses: body.requests.map((r) => ({ id: r.id, status: 201, body: {} })),
        });
      },
    ]);

    const api = new GraphCalendarApi(contextWith(fetchImpl, 'noid'), CONFIG, silentLogger);
    const results = await api.apply('cal-1', [{ kind: 'create', uid: 'uid', event }]);

    expect(results[0]).toMatchObject({ ok: false, status: 502 });
  });
});

describe('TokenProvider', () => {
  const graphConfig = (clientId: string) => ({ ...CONFIG.graph, clientId });

  it('requests a token once and caches it in KV', async () => {
    let requests = 0;
    const tokenFetch = (async () => {
      requests++;
      return jsonResponse({ access_token: 'token-abc', expires_in: 3600 });
    }) as unknown as typeof fetch;

    const provider = new TokenProvider(
      env.TV_SYNC_STATE,
      graphConfig('cache-test'),
      silentLogger,
      tokenFetch,
    );

    expect(await provider.get()).toBe('token-abc');
    expect(await provider.get()).toBe('token-abc');
    expect(requests).toBe(1);

    // A fresh provider hits the KV cache rather than the token endpoint.
    const second = new TokenProvider(
      env.TV_SYNC_STATE,
      graphConfig('cache-test'),
      silentLogger,
      tokenFetch,
    );
    expect(await second.get()).toBe('token-abc');
    expect(requests).toBe(1);
  });

  it('refreshes when fewer than five minutes remain', async () => {
    let issued = 0;
    const tokenFetch = (async () => {
      issued++;
      return jsonResponse({ access_token: `token-${issued}`, expires_in: 3600 });
    }) as unknown as typeof fetch;

    let clock = Date.now();
    const provider = new TokenProvider(
      env.TV_SYNC_STATE,
      graphConfig('refresh-test'),
      silentLogger,
      tokenFetch,
      () => clock,
    );

    expect(await provider.get()).toBe('token-1');

    // Roll forward to inside the refresh margin, with a fresh provider so the
    // in-run memo does not mask the cache decision.
    clock += 3400 * 1000;
    const later = new TokenProvider(
      env.TV_SYNC_STATE,
      graphConfig('refresh-test'),
      silentLogger,
      tokenFetch,
      () => clock,
    );

    expect(await later.get()).toBe('token-2');
    expect(issued).toBe(2);
  });

  it('binds the cache to the client secret, so rotating it forces a new token', async () => {
    let issued = 0;
    const tokenFetch = (async () => {
      issued++;
      return jsonResponse({ access_token: `token-${issued}`, expires_in: 3600 });
    }) as unknown as typeof fetch;

    const original = new TokenProvider(
      env.TV_SYNC_STATE,
      { ...graphConfig('rotate-test'), clientSecret: 'first-secret' },
      silentLogger,
      tokenFetch,
    );
    expect(await original.get()).toBe('token-1');

    const rotated = new TokenProvider(
      env.TV_SYNC_STATE,
      { ...graphConfig('rotate-test'), clientSecret: 'second-secret' },
      silentLogger,
      tokenFetch,
    );
    expect(await rotated.get()).toBe('token-2');
  });

  it('surfaces a token endpoint failure rather than caching it', async () => {
    let attempts = 0;
    const tokenFetch = (async () => {
      attempts++;
      return jsonResponse({ error: 'invalid_client' }, 401);
    }) as unknown as typeof fetch;

    const provider = new TokenProvider(
      env.TV_SYNC_STATE,
      graphConfig('failure-test'),
      silentLogger,
      tokenFetch,
    );

    await expect(provider.get()).rejects.toThrow(/401/);
    // The failure is not memoised, so a later call tries again.
    await expect(provider.get()).rejects.toThrow(/401/);
    expect(attempts).toBe(2);
  });
});
