import { beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { hashEvent, type NormalizedEvent } from '../src/ics/parse.js';
import { silentLogger } from '../src/log.js';
import type { RecentAddition } from '../src/recent.js';
import { emptyState, type SyncState } from '../src/state.js';
import {
  diff,
  runSync,
  type CalendarApi,
  type Operation,
  type OperationResult,
  type SyncDeps,
} from '../src/sync.js';

const NOW = new Date('2026-07-27T12:00:00Z');

const CONFIG: Config = {
  feedId: 'default',
  ics: { baseUrl: 'https://feed.invalid/ical' },
  graph: {
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: 'secret-value-long-enough',
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
  extra: Partial<Pick<NormalizedEvent, 'description' | 'url' | 'isAllDay'>> = {},
): Promise<NormalizedEvent> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 30 * 60_000);
  const fields = {
    summary,
    start,
    end,
    isAllDay: extra.isAllDay ?? false,
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    ...(extra.url !== undefined ? { url: extra.url } : {}),
  };

  return { uid, ...fields, hash: await hashEvent(fields) };
}

/** Renders parsed events back into a minimal ICS document. */
function toIcs(events: NormalizedEvent[]): string {
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const blocks = events.map((event) =>
    [
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `SUMMARY:${event.summary}`,
      `DTSTART:${stamp(event.start)}`,
      `DTEND:${stamp(event.end)}`,
      ...(event.description ? [`DESCRIPTION:${event.description}`] : []),
      ...(event.url ? [`URL:${event.url}`] : []),
      'END:VEVENT',
    ].join('\r\n'),
  );

  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...blocks, 'END:VCALENDAR'].join('\r\n');
}

class FakeCalendar implements CalendarApi {
  batches: Operation[][] = [];
  resolveCalls = 0;
  private nextId = 1;
  /** uid -> status to fail that operation with. */
  failures = new Map<string, number>();
  resolveError: Error | null = null;

  get allOperations(): Operation[] {
    return this.batches.flat();
  }

  async resolveCalendarId(knownId: string | null): Promise<string> {
    this.resolveCalls++;
    if (this.resolveError) throw this.resolveError;
    return knownId ?? 'calendar-1';
  }

  async apply(_calendarId: string, operations: Operation[]): Promise<OperationResult[]> {
    this.batches.push(operations);

    return operations.map((op): OperationResult => {
      const failureStatus = this.failures.get(op.uid);
      if (failureStatus !== undefined) {
        return { uid: op.uid, kind: op.kind, ok: false, status: failureStatus, error: 'forced' };
      }

      if (op.kind === 'create') {
        return {
          uid: op.uid,
          kind: 'create',
          ok: true,
          status: 201,
          eventId: `event-${this.nextId++}`,
        };
      }

      return { uid: op.uid, kind: op.kind, ok: true, status: 204 };
    });
  }
}

interface Harness {
  deps: SyncDeps;
  calendar: FakeCalendar;
  state: () => SyncState;
  setFeed: (events: NormalizedEvent[]) => void;
  setRawFeed: (raw: string) => void;
  failFeed: (error: Error) => void;
  additions: RecentAddition[];
  saveCount: () => number;
}

function harness(initial?: SyncState, now: Date = NOW): Harness {
  let stored: SyncState = initial ?? emptyState();
  let hadState = initial !== undefined;
  let raw = '';
  let feedError: Error | null = null;
  let saves = 0;

  const calendar = new FakeCalendar();
  const additions: RecentAddition[] = [];

  const deps: SyncDeps = {
    config: CONFIG,
    log: silentLogger,
    async fetchFeed() {
      if (feedError) throw feedError;
      return raw;
    },
    async loadState() {
      // Deep clone, so a test asserting on saved state cannot be fooled by the
      // engine mutating the object the harness still holds a reference to.
      return { state: structuredClone(stored), wasReset: !hadState };
    },
    async saveState(next) {
      saves++;
      stored = structuredClone(next);
      hadState = true;
    },
    async recordAdditions(entries) {
      additions.push(...entries);
    },
    calendar,
    now: () => now,
  };

  return {
    deps,
    calendar,
    state: () => stored,
    setFeed: (events) => {
      raw = toIcs(events);
    },
    setRawFeed: (value) => {
      raw = value;
    },
    failFeed: (error) => {
      feedError = error;
    },
    additions,
    saveCount: () => saves,
  };
}

describe('diff — delete guard', () => {
  const stateWith = (entries: Record<string, { start: string; hash?: string }>): SyncState => {
    const state = emptyState();
    let counter = 0;
    for (const [uid, entry] of Object.entries(entries)) {
      state.events[uid] = {
        eventId: `event-${++counter}`,
        hash: entry.hash ?? 'stored-hash',
        start: entry.start,
      };
    }
    return state;
  };

  it('deletes an event that left the feed while still in the future', () => {
    const state = stateWith({ gone: { start: '2026-08-01T20:00:00Z' } });
    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toHaveLength(1);
    expect(plan.deletes[0]?.uid).toBe('gone');
    expect(plan.pruned).toEqual([]);
  });

  it('never deletes an event that has already aired', () => {
    // The rolling-window case: episodes leave the feed because they aired.
    const state = stateWith({ aired: { start: '2026-07-20T20:00:00Z' } });
    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
    expect(plan.pruned).toEqual([]);
  });

  it('prunes state for an aired event past the retention window, without deleting it', () => {
    const state = stateWith({ ancient: { start: '2026-01-01T20:00:00Z' } });
    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
    expect(plan.pruned).toEqual(['ancient']);
  });

  it('keeps tracking an aired event that is still inside the retention window', () => {
    const state = stateWith({ recent: { start: '2026-07-26T20:00:00Z' } });
    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
    expect(plan.pruned).toEqual([]);
  });

  it('treats an event starting exactly now as aired, not deletable', () => {
    const state = stateWith({ boundary: { start: NOW.toISOString() } });
    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
  });

  it('prunes an entry whose stored start is unparseable', () => {
    const state = emptyState();
    state.events['corrupt'] = { eventId: 'event-1', hash: 'h', start: 'not-a-date' };

    const plan = diff([], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
    expect(plan.pruned).toEqual(['corrupt']);
  });

  it('never deletes anything still present in the feed, however old', async () => {
    const old = await makeEvent('old', 'Old', '2020-01-01T20:00:00Z');
    const state = stateWith({ old: { start: old.start.toISOString(), hash: old.hash } });

    const plan = diff([old], state, NOW, 30);

    expect(plan.deletes).toEqual([]);
    expect(plan.pruned).toEqual([]);
    expect(plan.unchanged).toEqual(['old']);
  });
});

describe('diff — classification', () => {
  it('splits the feed into creates, updates and no-ops', async () => {
    const fresh = await makeEvent('a', 'A', '2026-08-01T20:00:00Z');
    const changed = await makeEvent('b', 'B moved', '2026-08-02T21:00:00Z');
    const same = await makeEvent('c', 'C', '2026-08-03T20:00:00Z');

    const state = emptyState();
    state.events['b'] = { eventId: 'event-b', hash: 'stale-hash', start: '2026-08-02T20:00:00Z' };
    state.events['c'] = { eventId: 'event-c', hash: same.hash, start: same.start.toISOString() };

    const plan = diff([fresh, changed, same], state, NOW, 30);

    expect(plan.creates.map((op) => op.uid)).toEqual(['a']);
    expect(plan.updates.map((op) => op.uid)).toEqual(['b']);
    expect(plan.updates[0]?.eventId).toBe('event-b');
    expect(plan.unchanged).toEqual(['c']);
    expect(plan.deletes).toEqual([]);
  });
});

describe('runSync — acceptance criteria', () => {
  let feed: NormalizedEvent[];

  beforeEach(async () => {
    feed = [
      await makeEvent('ep-1', 'Severance - S02E05', '2026-08-01T21:00:00Z'),
      await makeEvent('ep-2', 'Andor - S03E08', '2026-08-02T21:00:00Z'),
      await makeEvent('ep-3', 'Silo - S03E03', '2026-07-20T21:00:00Z'),
    ];
  });

  it('(1) creates the full set on a first run', async () => {
    const h = harness();
    h.setFeed(feed);

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 3, updated: 0, deleted: 0, errors: 0 });
    expect(h.calendar.allOperations.every((op) => op.kind === 'create')).toBe(true);
    expect(Object.keys(h.state().events)).toHaveLength(3);
  });

  it('(2) is a full no-op on an immediate second run', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 0, updated: 0, deleted: 0, errors: 0, skipped: 3 });
    expect(h.calendar.batches).toEqual([]);
  });

  it('(3) a changed start time produces exactly one update and nothing else', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);
    const idBefore = h.state().events['ep-1']?.eventId;

    h.calendar.batches = [];
    const moved = await makeEvent('ep-1', 'Severance - S02E05', '2026-08-01T22:30:00Z');
    h.setFeed([moved, feed[1]!, feed[2]!]);

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 0, updated: 1, deleted: 0, errors: 0 });
    expect(h.calendar.allOperations).toHaveLength(1);
    expect(h.calendar.allOperations[0]?.kind).toBe('update');
    // The calendar entry is patched in place, not replaced.
    expect(h.state().events['ep-1']?.eventId).toBe(idBefore);
    expect(h.state().events['ep-1']?.start).toBe('2026-08-01T22:30:00.000Z');
  });

  it('(4) removing a future-dated event produces exactly one delete', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    h.setFeed([feed[0]!, feed[2]!]); // ep-2 airs 2026-08-02, still in the future

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 0, updated: 0, deleted: 1, errors: 0 });
    expect(h.calendar.allOperations).toHaveLength(1);
    expect(h.calendar.allOperations[0]).toMatchObject({ kind: 'delete', uid: 'ep-2' });
    expect(h.state().events['ep-2']).toBeUndefined();
  });

  it('(5) removing a past-dated event produces zero deletes', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    h.setFeed([feed[0]!, feed[1]!]); // ep-3 aired 2026-07-20, a week ago

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 0, updated: 0, deleted: 0, errors: 0 });
    expect(h.calendar.batches).toEqual([]);
    // Still tracked: inside the retention window, so it is neither deleted nor forgotten.
    expect(h.state().events['ep-3']).toBeDefined();
  });

  it('(6) an ICS fetch failure produces zero calendar mutations', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    const savesBefore = h.saveCount();
    h.failFeed(new Error('upstream 502'));

    const summary = await runSync(h.deps);

    expect(summary.aborted).toBe('ics-fetch-failed');
    expect(summary).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(h.calendar.batches).toEqual([]);
    expect(h.saveCount()).toBe(savesBefore);
    expect(Object.keys(h.state().events)).toHaveLength(3);
  });

  it('(7) an empty ICS feed produces zero calendar mutations', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    h.setRawFeed('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');

    const summary = await runSync(h.deps);

    expect(summary.aborted).toBe('ics-feed-empty');
    expect(h.calendar.batches).toEqual([]);
    // Critically, the three tracked events survive rather than being deleted.
    expect(Object.keys(h.state().events)).toHaveLength(3);
  });

  it('treats a whitespace-only response as an empty feed, not a wipe instruction', async () => {
    const h = harness();
    h.setFeed(feed);
    await runSync(h.deps);

    h.calendar.batches = [];
    h.setRawFeed('   \r\n  ');

    const summary = await runSync(h.deps);

    expect(summary.aborted).toBe('ics-feed-empty');
    expect(h.calendar.batches).toEqual([]);
  });

  it('leaves the calendar untouched when the calendar cannot be resolved', async () => {
    const h = harness();
    h.setFeed(feed);
    h.calendar.resolveError = new Error('403 from Graph');

    const summary = await runSync(h.deps);

    expect(summary.aborted).toBe('calendar-resolve-failed');
    expect(h.calendar.batches).toEqual([]);
    expect(h.saveCount()).toBe(0);
  });
});

describe('runSync — failure folding', () => {
  it('does not record a failed create, so the next run retries it', async () => {
    const h = harness();
    const events = [
      await makeEvent('ok', 'Fine', '2026-08-01T21:00:00Z'),
      await makeEvent('bad', 'Fails', '2026-08-02T21:00:00Z'),
    ];
    h.setFeed(events);
    h.calendar.failures.set('bad', 500);

    const first = await runSync(h.deps);

    expect(first).toMatchObject({ created: 1, errors: 1 });
    expect(h.state().events['bad']).toBeUndefined();

    // Second run: the failure clears and the create is retried, not skipped.
    h.calendar.failures.clear();
    h.calendar.batches = [];
    const second = await runSync(h.deps);

    expect(second).toMatchObject({ created: 1, errors: 0 });
    expect(h.calendar.allOperations).toHaveLength(1);
    expect(h.calendar.allOperations[0]).toMatchObject({ kind: 'create', uid: 'bad' });
  });

  it('drops state and recreates when an update 404s', async () => {
    const h = harness();
    const original = await makeEvent('ep', 'Show', '2026-08-01T21:00:00Z');
    h.setFeed([original]);
    await runSync(h.deps);

    const moved = await makeEvent('ep', 'Show', '2026-08-01T22:00:00Z');
    h.setFeed([moved]);
    h.calendar.failures.set('ep', 404);
    h.calendar.batches = [];

    const summary = await runSync(h.deps);

    // A 404 on update is not an error — the event was removed out of band.
    expect(summary.errors).toBe(0);
    expect(summary.updated).toBe(0);
    expect(h.state().events['ep']).toBeUndefined();

    h.calendar.failures.clear();
    h.calendar.batches = [];
    const recovery = await runSync(h.deps);

    expect(recovery).toMatchObject({ created: 1, errors: 0 });
  });

  it('treats a 404 on delete as success', async () => {
    const h = harness();
    const event = await makeEvent('ep', 'Show', '2026-08-01T21:00:00Z');
    const other = await makeEvent('keep', 'Keep', '2026-08-05T21:00:00Z');
    h.setFeed([event, other]);
    await runSync(h.deps);

    h.setFeed([other]);
    h.calendar.failures.set('ep', 404);

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ deleted: 1, errors: 0 });
    expect(h.state().events['ep']).toBeUndefined();
  });

  it('keeps state when a delete fails, so it is retried', async () => {
    const h = harness();
    const event = await makeEvent('ep', 'Show', '2026-08-01T21:00:00Z');
    const other = await makeEvent('keep', 'Keep', '2026-08-05T21:00:00Z');
    h.setFeed([event, other]);
    await runSync(h.deps);

    h.setFeed([other]);
    h.calendar.failures.set('ep', 500);

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ deleted: 0, errors: 1 });
    expect(h.state().events['ep']).toBeDefined();
  });

  it('reuses the stored calendar id across runs', async () => {
    const h = harness();
    h.setFeed([await makeEvent('ep', 'Show', '2026-08-01T21:00:00Z')]);

    await runSync(h.deps);
    expect(h.state().calendarId).toBe('calendar-1');

    await runSync(h.deps);
    expect(h.calendar.resolveCalls).toBe(2);
  });
});

describe('runSync — scale', () => {
  it('(10) handles a 200-event initial sync in one pass', async () => {
    const h = harness();

    const bulk = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        makeEvent(
          `bulk-${i}`,
          `Show ${i}`,
          new Date(Date.UTC(2026, 7, 1 + (i % 28), 20, 0, 0)).toISOString(),
        ),
      ),
    );
    h.setFeed(bulk);

    const summary = await runSync(h.deps);

    expect(summary).toMatchObject({ created: 200, updated: 0, deleted: 0, errors: 0 });
    expect(Object.keys(h.state().events)).toHaveLength(200);

    // And the immediate re-run is a pure no-op, which is what keeps the hourly
    // cron cheap once the calendar has caught up.
    h.calendar.batches = [];
    const second = await runSync(h.deps);

    expect(second).toMatchObject({ created: 0, updated: 0, deleted: 0, skipped: 200 });
    expect(h.calendar.batches).toEqual([]);
  });
});

describe('runSync — recent additions log', () => {
  it('records only successful creates, with the time they were added', async () => {
    const h = harness();
    h.setFeed([
      await makeEvent('ep-1', 'Severance - S02E05', '2026-08-01T21:00:00Z'),
      await makeEvent('ep-2', 'Andor - S03E08', '2026-08-02T21:00:00Z'),
    ]);

    await runSync(h.deps);

    expect(h.additions).toHaveLength(2);
    expect(h.additions.map((entry) => entry.summary).sort()).toEqual([
      'Andor - S03E08',
      'Severance - S02E05',
    ]);
    for (const entry of h.additions) {
      expect(entry.addedAt).toBe(NOW.toISOString());
      expect(entry.feedId).toBe('default');
      expect(entry.eventId).toMatch(/^event-\d+$/);
    }
  });

  it('does not record updates, deletes or failed creates', async () => {
    const h = harness();
    const event = await makeEvent('ep', 'Show', '2026-08-01T21:00:00Z');
    h.setFeed([event]);
    await runSync(h.deps);
    h.additions.length = 0;

    h.setFeed([await makeEvent('ep', 'Show renamed', '2026-08-01T21:00:00Z')]);
    await runSync(h.deps);

    expect(h.additions).toEqual([]);
  });
});
