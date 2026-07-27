/**
 * Sync state persistence.
 *
 * One KV key holds the whole UID -> event map. KV allows roughly one write per
 * second per key, so a single blob read once and written once per run is both
 * faster and cheaper than N per-event keys — and it keeps the run atomic from
 * the reader's point of view.
 *
 * The key is scoped by feed id so a second feed can be added later without
 * migrating or colliding with this one.
 */

import type { Logger } from './log.js';

export const STATE_VERSION = 1 as const;

export interface StoredEvent {
  /** Graph event id. */
  eventId: string;
  /** Content hash at the time it was last written. */
  hash: string;
  /** ISO 8601 start, retained so the delete guard and prune can run without the feed. */
  start: string;
}

export interface SyncState {
  version: typeof STATE_VERSION;
  calendarId: string | null;
  lastSyncAt: string;
  events: Record<string, StoredEvent>;
}

export function stateKey(feedId: string): string {
  return `sync-state:${feedId}`;
}

export function emptyState(): SyncState {
  return {
    version: STATE_VERSION,
    calendarId: null,
    lastSyncAt: new Date(0).toISOString(),
    events: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuild state from untrusted JSON, dropping anything malformed rather than
 * throwing. A single corrupt entry should cost one event, not the whole run —
 * and anything dropped here is simply recreated on the next sync.
 */
function reviveState(raw: unknown, log: Logger): SyncState | null {
  if (!isRecord(raw)) return null;
  if (raw['version'] !== STATE_VERSION) {
    log.warn('Discarding sync state with unknown schema version', {
      found: raw['version'],
      expected: STATE_VERSION,
    });
    return null;
  }

  const state = emptyState();

  if (typeof raw['calendarId'] === 'string' && raw['calendarId']) {
    state.calendarId = raw['calendarId'];
  }
  if (typeof raw['lastSyncAt'] === 'string' && !Number.isNaN(Date.parse(raw['lastSyncAt']))) {
    state.lastSyncAt = raw['lastSyncAt'];
  }

  const events = raw['events'];
  if (!isRecord(events)) return state;

  let dropped = 0;
  for (const [uid, entry] of Object.entries(events)) {
    if (!uid || !isRecord(entry)) {
      dropped++;
      continue;
    }

    const { eventId, hash, start } = entry;
    if (
      typeof eventId !== 'string' ||
      !eventId ||
      typeof hash !== 'string' ||
      !hash ||
      typeof start !== 'string' ||
      Number.isNaN(Date.parse(start))
    ) {
      dropped++;
      continue;
    }

    state.events[uid] = { eventId, hash, start };
  }

  if (dropped > 0) {
    log.warn('Dropped malformed entries while loading sync state', { dropped });
  }

  return state;
}

export async function loadState(
  kv: KVNamespace,
  feedId: string,
  log: Logger,
): Promise<{ state: SyncState; wasReset: boolean }> {
  let raw: unknown;
  try {
    raw = await kv.get(stateKey(feedId), 'json');
  } catch (error) {
    // Unparseable JSON in KV lands here. Treat it as a first sync.
    log.warn('Sync state could not be read; treating this run as a first sync', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { state: emptyState(), wasReset: true };
  }

  if (raw === null || raw === undefined) {
    return { state: emptyState(), wasReset: true };
  }

  const revived = reviveState(raw, log);
  if (!revived) return { state: emptyState(), wasReset: true };

  return { state: revived, wasReset: false };
}

export async function saveState(
  kv: KVNamespace,
  feedId: string,
  state: SyncState,
): Promise<void> {
  await kv.put(stateKey(feedId), JSON.stringify(state));
}

/** Count of tracked events, for logging. */
export function trackedCount(state: SyncState): number {
  return Object.keys(state.events).length;
}
