/**
 * An inspectable log of the most recently added episodes.
 *
 * Kept in its own KV key rather than inside `sync-state` for two reasons: it has
 * its own ~1 write/sec budget, so a busy sync run never contends with the state
 * write; and wiping or reversioning sync state does not erase the history.
 *
 * Entries are stamped with the feed they came from, so when more feeds are added
 * this stays a single merged "what showed up recently" view.
 *
 * Inspect with:
 *   wrangler kv key get --binding TV_SYNC_STATE recent-additions --remote
 * or over HTTP at GET /recent with the manual-trigger token.
 */

import type { Logger } from './log.js';

export const RECENT_KEY = 'recent-additions';
export const RECENT_VERSION = 1 as const;

/** Hard ceiling regardless of RECENT_LIMIT — KV values are capped at 25 MiB. */
const MAX_ENTRIES = 1000;

export interface RecentAddition {
  /** ICS UID of the episode. */
  uid: string;
  /** Episode title as it was written to the calendar. */
  summary: string;
  /** When the episode airs, ISO 8601. */
  start: string;
  /** When this sync created it, ISO 8601. */
  addedAt: string;
  /** Graph event id, so an entry can be traced to the calendar item. */
  eventId: string;
  /** Which feed it came from. */
  feedId: string;
}

export interface RecentLog {
  version: typeof RECENT_VERSION;
  entries: RecentAddition[];
}

export function emptyRecentLog(): RecentLog {
  return { version: RECENT_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reviveEntry(raw: unknown): RecentAddition | null {
  if (!isRecord(raw)) return null;

  const { uid, summary, start, addedAt, eventId, feedId } = raw;
  if (
    typeof uid !== 'string' ||
    typeof summary !== 'string' ||
    typeof start !== 'string' ||
    typeof addedAt !== 'string' ||
    typeof eventId !== 'string'
  ) {
    return null;
  }

  return {
    uid,
    summary,
    start,
    addedAt,
    eventId,
    feedId: typeof feedId === 'string' ? feedId : 'unknown',
  };
}

export async function loadRecentLog(kv: KVNamespace, log: Logger): Promise<RecentLog> {
  let raw: unknown;
  try {
    raw = await kv.get(RECENT_KEY, 'json');
  } catch (error) {
    log.warn('Recent-additions log could not be read; starting a fresh one', {
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyRecentLog();
  }

  if (!isRecord(raw) || raw['version'] !== RECENT_VERSION || !Array.isArray(raw['entries'])) {
    return emptyRecentLog();
  }

  return {
    version: RECENT_VERSION,
    entries: raw['entries']
      .map(reviveEntry)
      .filter((entry): entry is RecentAddition => entry !== null),
  };
}

/**
 * Prepend newly created episodes and trim to `limit`, newest first.
 *
 * A no-op when nothing was created, which is the common case once the calendar
 * has caught up — that keeps the steady state at zero writes to this key.
 */
export async function recordAdditions(
  kv: KVNamespace,
  additions: RecentAddition[],
  limit: number,
  log: Logger,
): Promise<void> {
  if (additions.length === 0) return;

  const existing = await loadRecentLog(kv, log);
  const cap = Math.min(Math.max(limit, 1), MAX_ENTRIES);

  // Newest first. Within one run, later air dates sort first so the list reads
  // consistently rather than in whatever order the batch responses arrived.
  const incoming = [...additions].sort((a, b) => b.start.localeCompare(a.start));

  const merged = [...incoming, ...existing.entries].slice(0, cap);

  try {
    await kv.put(RECENT_KEY, JSON.stringify({ version: RECENT_VERSION, entries: merged }));
  } catch (error) {
    // This log is a convenience, never a correctness requirement. Losing a write
    // here must not fail a sync that already succeeded against the calendar.
    log.warn('Could not write the recent-additions log', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
