import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../src/log.js';
import { loadRecentLog, recordAdditions, RECENT_KEY, type RecentAddition } from '../src/recent.js';
import { emptyState, loadState, saveState, stateKey, trackedCount } from '../src/state.js';

const kv = () => env.TV_SYNC_STATE;

let counter = 0;
/** A distinct feed id per test, so the shared KV namespace cannot leak between them. */
const uniqueFeed = () => `test-feed-${++counter}`;

describe('state persistence', () => {
  it('reports a first sync when nothing is stored', async () => {
    const { state, wasReset } = await loadState(kv(), uniqueFeed(), silentLogger);

    expect(wasReset).toBe(true);
    expect(state.calendarId).toBeNull();
    expect(state.events).toEqual({});
  });

  it('round-trips through KV', async () => {
    const feedId = uniqueFeed();
    const state = emptyState();
    state.calendarId = 'cal-1';
    state.lastSyncAt = '2026-07-27T12:00:00.000Z';
    state.events['ep-1'] = {
      eventId: 'event-1',
      hash: 'abc',
      start: '2026-08-01T20:00:00.000Z',
    };

    await saveState(kv(), feedId, state);
    const { state: loaded, wasReset } = await loadState(kv(), feedId, silentLogger);

    expect(wasReset).toBe(false);
    expect(loaded).toEqual(state);
    expect(trackedCount(loaded)).toBe(1);
  });

  it('scopes state per feed id', async () => {
    const first = uniqueFeed();
    const second = uniqueFeed();

    const state = emptyState();
    state.calendarId = 'cal-first';
    await saveState(kv(), first, state);

    const { state: other, wasReset } = await loadState(kv(), second, silentLogger);

    expect(wasReset).toBe(true);
    expect(other.calendarId).toBeNull();
    expect(stateKey(first)).not.toBe(stateKey(second));
  });

  it('discards state written under a different schema version', async () => {
    const feedId = uniqueFeed();
    await kv().put(
      stateKey(feedId),
      JSON.stringify({ version: 99, calendarId: 'cal-old', events: { a: {} } }),
    );

    const { state, wasReset } = await loadState(kv(), feedId, silentLogger);

    expect(wasReset).toBe(true);
    expect(state.calendarId).toBeNull();
    expect(state.events).toEqual({});
  });

  it('drops malformed entries but keeps the sound ones', async () => {
    const feedId = uniqueFeed();
    await kv().put(
      stateKey(feedId),
      JSON.stringify({
        version: 1,
        calendarId: 'cal-1',
        lastSyncAt: '2026-07-27T12:00:00.000Z',
        events: {
          good: { eventId: 'event-1', hash: 'h1', start: '2026-08-01T20:00:00.000Z' },
          missingId: { hash: 'h2', start: '2026-08-01T20:00:00.000Z' },
          badStart: { eventId: 'event-3', hash: 'h3', start: 'nonsense' },
          notAnObject: 'oops',
        },
      }),
    );

    const { state, wasReset } = await loadState(kv(), feedId, silentLogger);

    expect(wasReset).toBe(false);
    expect(Object.keys(state.events)).toEqual(['good']);
    expect(state.calendarId).toBe('cal-1');
  });

  it('treats unparseable JSON as a first sync rather than throwing', async () => {
    const feedId = uniqueFeed();
    await kv().put(stateKey(feedId), 'not json at all');

    const { state, wasReset } = await loadState(kv(), feedId, silentLogger);

    expect(wasReset).toBe(true);
    expect(state.events).toEqual({});
  });
});

describe('recent-additions log', () => {
  const addition = (uid: string, summary: string, start: string, addedAt: string): RecentAddition => ({
    uid,
    summary,
    start,
    addedAt,
    eventId: `event-${uid}`,
    feedId: 'default',
  });

  it('starts empty', async () => {
    await kv().delete(RECENT_KEY);
    const log = await loadRecentLog(kv(), silentLogger);

    expect(log.entries).toEqual([]);
  });

  it('records what was added and when', async () => {
    await kv().delete(RECENT_KEY);

    await recordAdditions(
      kv(),
      [addition('ep-1', 'Severance - S02E05', '2026-08-01T21:00:00.000Z', '2026-07-27T12:00:00.000Z')],
      100,
      silentLogger,
    );

    const log = await loadRecentLog(kv(), silentLogger);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      uid: 'ep-1',
      summary: 'Severance - S02E05',
      addedAt: '2026-07-27T12:00:00.000Z',
      feedId: 'default',
    });
  });

  it('puts the newest run first', async () => {
    await kv().delete(RECENT_KEY);

    await recordAdditions(
      kv(),
      [addition('old', 'Older run', '2026-08-01T21:00:00.000Z', '2026-07-20T12:00:00.000Z')],
      100,
      silentLogger,
    );
    await recordAdditions(
      kv(),
      [addition('new', 'Newer run', '2026-08-05T21:00:00.000Z', '2026-07-27T12:00:00.000Z')],
      100,
      silentLogger,
    );

    const log = await loadRecentLog(kv(), silentLogger);

    expect(log.entries.map((entry) => entry.uid)).toEqual(['new', 'old']);
  });

  it('caps the log at the configured limit, discarding the oldest', async () => {
    await kv().delete(RECENT_KEY);

    for (let i = 0; i < 12; i++) {
      await recordAdditions(
        kv(),
        [
          addition(
            `ep-${i}`,
            `Episode ${i}`,
            `2026-08-${String(i + 1).padStart(2, '0')}T21:00:00.000Z`,
            '2026-07-27T12:00:00.000Z',
          ),
        ],
        10,
        silentLogger,
      );
    }

    const log = await loadRecentLog(kv(), silentLogger);

    expect(log.entries).toHaveLength(10);
    // The two earliest additions have aged out.
    expect(log.entries.map((entry) => entry.uid)).not.toContain('ep-0');
    expect(log.entries.map((entry) => entry.uid)).toContain('ep-11');
  });

  it('holds 100 entries at the default limit', async () => {
    await kv().delete(RECENT_KEY);

    const batch = Array.from({ length: 150 }, (_, i) =>
      addition(`bulk-${i}`, `Bulk ${i}`, '2026-08-01T21:00:00.000Z', '2026-07-27T12:00:00.000Z'),
    );
    await recordAdditions(kv(), batch, 100, silentLogger);

    const log = await loadRecentLog(kv(), silentLogger);
    expect(log.entries).toHaveLength(100);
  });

  it('writes nothing when a run created nothing', async () => {
    await kv().delete(RECENT_KEY);
    await recordAdditions(kv(), [], 100, silentLogger);

    expect(await kv().get(RECENT_KEY)).toBeNull();
  });

  it('recovers from a corrupt log rather than throwing', async () => {
    await kv().put(RECENT_KEY, JSON.stringify({ version: 1, entries: 'not-an-array' }));

    const log = await loadRecentLog(kv(), silentLogger);
    expect(log.entries).toEqual([]);
  });
});
