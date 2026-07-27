import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../src/log.js';
import { recordAdditions, RECENT_KEY } from '../src/recent.js';

const TOKEN = 'test-manual-trigger-token-0123456789abcdef';

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://airdate.test${path}`, init);

const authed = (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` } });

describe('HTTP surface — authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await call('/recent');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('rejects a wrong token', async () => {
    const response = await call('/recent', {
      headers: { Authorization: 'Bearer definitely-not-the-right-token-here' },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await call('/recent', { headers: { Authorization: TOKEN } });

    expect(response.status).toBe(401);
  });

  it('never sets CORS headers, so no web page can read these responses', async () => {
    const response = await authed('/status');

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s an unknown path even when authenticated', async () => {
    const response = await authed('/admin');

    expect(response.status).toBe(404);
  });

  it('does not accept GET on the sync endpoint', async () => {
    expect((await authed('/sync')).status).toBe(404);
  });
});

describe('HTTP surface — inspection', () => {
  it('returns the recent-additions log newest first', async () => {
    await env.TV_SYNC_STATE.delete(RECENT_KEY);
    await recordAdditions(
      env.TV_SYNC_STATE,
      [
        {
          uid: 'ep-1',
          summary: 'Severance - S02E05',
          start: '2026-08-01T21:00:00.000Z',
          addedAt: '2026-07-27T12:00:00.000Z',
          eventId: 'event-1',
          feedId: 'default',
        },
        {
          uid: 'ep-2',
          summary: 'Andor - S03E08',
          start: '2026-08-05T21:00:00.000Z',
          addedAt: '2026-07-27T12:00:00.000Z',
          eventId: 'event-2',
          feedId: 'default',
        },
      ],
      100,
      silentLogger,
    );

    const response = await authed('/recent');
    const body = (await response.json()) as {
      count: number;
      entries: Array<{ uid: string; summary: string; addedAt: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.entries[0]?.summary).toBe('Andor - S03E08');
    expect(body.entries[0]?.addedAt).toBe('2026-07-27T12:00:00.000Z');
  });

  it('honours a limit query parameter', async () => {
    const response = await authed('/recent?limit=1');
    const body = (await response.json()) as { entries: unknown[] };

    expect(body.entries).toHaveLength(1);
  });

  it('ignores a nonsense limit rather than erroring', async () => {
    const response = await authed('/recent?limit=-5');

    expect(response.status).toBe(200);
  });

  it('reports sync status without leaking configuration', async () => {
    const response = await authed('/status');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body['calendarName']).toBe('TV');
    expect(Object.keys(body)).not.toContain('graph');

    // Nothing secret anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('test-client-secret');
    expect(serialized).not.toContain(TOKEN);
  });
});
