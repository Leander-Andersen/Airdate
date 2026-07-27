/**
 * The reconciliation algorithm.
 *
 * Deliberately structured so the decision-making (`diff`) is a pure function of
 * feed + state + clock. Everything that touches the network sits behind the
 * `SyncDeps` interface, which is what makes the delete rules exhaustively
 * testable without a Graph account.
 */

import type { Config } from './config.js';
import type { NormalizedEvent } from './ics/parse.js';
import { parseIcs } from './ics/parse.js';
import type { Logger } from './log.js';
import type { RecentAddition } from './recent.js';
import type { StoredEvent, SyncState } from './state.js';

export type OperationKind = 'create' | 'update' | 'delete';

export interface CreateOperation {
  kind: 'create';
  uid: string;
  event: NormalizedEvent;
}

export interface UpdateOperation {
  kind: 'update';
  uid: string;
  eventId: string;
  event: NormalizedEvent;
}

export interface DeleteOperation {
  kind: 'delete';
  uid: string;
  eventId: string;
}

export type Operation = CreateOperation | UpdateOperation | DeleteOperation;

export interface DiffResult {
  creates: CreateOperation[];
  updates: UpdateOperation[];
  deletes: DeleteOperation[];
  /** UIDs present in both with matching hashes — nothing to do. */
  unchanged: string[];
  /** UIDs dropped from state without issuing a Graph delete. */
  pruned: string[];
}

export interface OperationResult {
  uid: string;
  kind: OperationKind;
  ok: boolean;
  status: number;
  /** Set on a successful create. */
  eventId?: string;
  error?: string;
}

export interface CalendarApi {
  /** Verify `knownId` still exists, else find-or-create by name. Returns the id. */
  resolveCalendarId(knownId: string | null): Promise<string>;
  apply(calendarId: string, operations: Operation[]): Promise<OperationResult[]>;
}

export interface SyncDeps {
  config: Config;
  log: Logger;
  fetchFeed(): Promise<string>;
  loadState(): Promise<{ state: SyncState; wasReset: boolean }>;
  saveState(state: SyncState): Promise<void>;
  recordAdditions(additions: RecentAddition[]): Promise<void>;
  calendar: CalendarApi;
  now(): Date;
}

export interface SyncSummary {
  created: number;
  updated: number;
  deleted: number;
  /** Unchanged events that needed no write. */
  skipped: number;
  pruned: number;
  errors: number;
  durationMs: number;
  /** Set when the run stopped early without mutating the calendar. */
  aborted?: string;
}

const DAY_MS = 86_400_000;

/**
 * Decide what the calendar needs, given the feed and what we last wrote.
 *
 *   CREATE  — in the feed, not in state
 *   UPDATE  — in both, content hash differs
 *   NOOP    — in both, hashes match
 *   DELETE  — in state, gone from the feed, AND its start is still in the future
 *   PRUNE   — in state, gone from the feed, and older than the retention window
 *
 * The delete guard is the load-bearing rule. These feeds cover a rolling window,
 * so episodes drop out of them simply because they have aired. That is not a
 * cancellation. Without the future-start check every run would delete everything
 * that had already aired and the calendar would keep no history at all.
 */
export function diff(
  feed: NormalizedEvent[],
  state: SyncState,
  now: Date,
  retentionDays: number,
): DiffResult {
  const result: DiffResult = {
    creates: [],
    updates: [],
    deletes: [],
    unchanged: [],
    pruned: [],
  };

  const feedUids = new Set<string>();

  for (const event of feed) {
    feedUids.add(event.uid);
    const stored: StoredEvent | undefined = state.events[event.uid];

    if (!stored) {
      result.creates.push({ kind: 'create', uid: event.uid, event });
    } else if (stored.hash !== event.hash) {
      result.updates.push({ kind: 'update', uid: event.uid, eventId: stored.eventId, event });
    } else {
      result.unchanged.push(event.uid);
    }
  }

  const nowMs = now.getTime();
  const retentionCutoffMs = nowMs - retentionDays * DAY_MS;

  for (const [uid, stored] of Object.entries(state.events)) {
    if (feedUids.has(uid)) continue;

    const startMs = Date.parse(stored.start);

    // Still in the future and no longer in the feed: a genuine removal.
    if (Number.isFinite(startMs) && startMs > nowMs) {
      result.deletes.push({ kind: 'delete', uid, eventId: stored.eventId });
      continue;
    }

    // Aired long enough ago to stop tracking. Forget it, but leave the calendar
    // entry alone — the user's history is the whole point.
    if (!Number.isFinite(startMs) || startMs < retentionCutoffMs) {
      result.pruned.push(uid);
    }

    // Anything else has aired recently: keep tracking it, but never delete it.
  }

  return result;
}

interface ApplyOutcome {
  created: number;
  updated: number;
  deleted: number;
  errors: number;
  additions: RecentAddition[];
}

/**
 * Fold operation results back into state.
 *
 * The guiding rule is that a failure must leave state describing what is
 * genuinely on the calendar, so the next run retries exactly the work that did
 * not land — no duplicates, no silently dropped events.
 */
function applyResults(
  state: SyncState,
  diffResult: DiffResult,
  results: OperationResult[],
  now: Date,
  feedId: string,
  log: Logger,
): ApplyOutcome {
  const outcome: ApplyOutcome = {
    created: 0,
    updated: 0,
    deleted: 0,
    errors: 0,
    additions: [],
  };

  const createdEvents = new Map(diffResult.creates.map((op) => [op.uid, op.event]));
  const updatedEvents = new Map(diffResult.updates.map((op) => [op.uid, op.event]));
  const nowIso = now.toISOString();

  for (const result of results) {
    if (result.kind === 'create') {
      const event = createdEvents.get(result.uid);
      if (!result.ok || !result.eventId || !event) {
        outcome.errors++;
        // Not recorded in state, so the next run retries the create. Graph's
        // transactionId dedupes if the event actually did land.
        continue;
      }

      state.events[result.uid] = {
        eventId: result.eventId,
        hash: event.hash,
        start: event.start.toISOString(),
      };
      outcome.created++;
      outcome.additions.push({
        uid: result.uid,
        summary: event.summary,
        start: event.start.toISOString(),
        addedAt: nowIso,
        eventId: result.eventId,
        feedId,
      });
      continue;
    }

    if (result.kind === 'update') {
      const event = updatedEvents.get(result.uid);

      if (result.status === 404) {
        // Removed out of band. Forget it; the next run recreates it.
        delete state.events[result.uid];
        log.debug('Event vanished before update; dropping from state', { uid: result.uid });
        continue;
      }

      if (!result.ok || !event) {
        outcome.errors++;
        continue;
      }

      const existing = state.events[result.uid];
      if (existing) {
        existing.hash = event.hash;
        existing.start = event.start.toISOString();
      }
      outcome.updated++;
      continue;
    }

    // delete
    if (result.ok || result.status === 404) {
      delete state.events[result.uid];
      outcome.deleted++;
      continue;
    }
    outcome.errors++;
  }

  for (const uid of diffResult.pruned) {
    delete state.events[uid];
  }

  return outcome;
}

export async function runSync(deps: SyncDeps): Promise<SyncSummary> {
  const startedAt = Date.now();
  const { config, log } = deps;

  const abort = (reason: string, errors = 0): SyncSummary => ({
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    pruned: 0,
    errors,
    durationMs: Date.now() - startedAt,
    aborted: reason,
  });

  // 1. Fetch and parse. A failed fetch must never be treated as an empty feed.
  let raw: string;
  try {
    raw = await deps.fetchFeed();
  } catch (error) {
    log.error('ICS fetch failed; leaving the calendar untouched', {
      error: error instanceof Error ? error.message : String(error),
    });
    return abort('ics-fetch-failed', 1);
  }

  let feed: NormalizedEvent[];
  try {
    feed = await parseIcs(raw, {
      defaultDurationMinutes: config.defaultDurationMinutes,
      fallbackTimeZone: config.displayTimeZone,
    });
  } catch (error) {
    log.error('ICS parse failed; leaving the calendar untouched', {
      error: error instanceof Error ? error.message : String(error),
    });
    return abort('ics-parse-failed', 1);
  }

  // An empty feed is far more likely to be an expired token or an upstream
  // outage than a genuine "nothing is airing". Acting on it would delete every
  // future event we track, so it is treated as a failed run.
  if (feed.length === 0) {
    log.warn('ICS feed parsed to zero events; refusing to reconcile against it', {
      bytes: raw.length,
    });
    return abort('ics-feed-empty', 1);
  }

  log.debug('Feed parsed', { events: feed.length });

  // 2. Load state.
  const { state, wasReset } = await deps.loadState();
  if (wasReset) {
    log.info('No usable prior state; treating this as a first sync');
  }

  // 3. Resolve the target calendar.
  let calendarId: string;
  try {
    calendarId = await deps.calendar.resolveCalendarId(state.calendarId);
  } catch (error) {
    log.error('Could not resolve the target calendar; leaving it untouched', {
      error: error instanceof Error ? error.message : String(error),
    });
    return abort('calendar-resolve-failed', 1);
  }
  state.calendarId = calendarId;

  // 4 & 5. Diff and prune.
  const now = deps.now();
  const plan = diff(feed, state, now, config.stateRetentionDays);

  log.debug('Diff computed', {
    creates: plan.creates.length,
    updates: plan.updates.length,
    deletes: plan.deletes.length,
    unchanged: plan.unchanged.length,
    pruned: plan.pruned.length,
    createUids: plan.creates.map((op) => op.uid),
    updateUids: plan.updates.map((op) => op.uid),
    deleteUids: plan.deletes.map((op) => op.uid),
  });

  // 6. Apply. Creates first so a rename that arrives as delete+create cannot
  // leave a gap, deletes last for the same reason.
  const operations: Operation[] = [...plan.creates, ...plan.updates, ...plan.deletes];

  let results: OperationResult[] = [];
  if (operations.length > 0) {
    try {
      results = await deps.calendar.apply(calendarId, operations);
    } catch (error) {
      log.error('Batch application failed outright', {
        error: error instanceof Error ? error.message : String(error),
      });
      return abort('apply-failed', 1);
    }
  }

  // 7. Fold results into state and persist.
  const outcome = applyResults(state, plan, results, now, config.feedId, log);

  state.lastSyncAt = now.toISOString();

  try {
    await deps.saveState(state);
  } catch (error) {
    // The calendar is already mutated at this point. Losing the state write
    // means the next run re-derives the diff from stale state, which is
    // recoverable, but it is worth shouting about.
    log.error('Calendar was updated but sync state could not be saved', {
      error: error instanceof Error ? error.message : String(error),
    });
    outcome.errors++;
  }

  await deps.recordAdditions(outcome.additions);

  return {
    created: outcome.created,
    updated: outcome.updated,
    deleted: outcome.deleted,
    skipped: plan.unchanged.length,
    pruned: plan.pruned.length,
    errors: outcome.errors,
    durationMs: Date.now() - startedAt,
  };
}
