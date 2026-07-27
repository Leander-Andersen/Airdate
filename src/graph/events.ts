/**
 * Graph event payload construction.
 *
 * Feed content is attacker-influenceable in the general case (anyone who can get
 * a show listing edited upstream controls these strings), so the body is always
 * sent as `contentType: "text"`. Graph then treats it as literal text rather than
 * markup, which means a synopsis cannot inject HTML or script into the calendar
 * item as rendered by Outlook.
 */

import type { Config } from '../config.js';
import type { NormalizedEvent } from '../ics/parse.js';
import { formatAllDayBoundary, formatWallTimeInZone } from '../time.js';

/** Graph rejects subjects past 255 characters. */
const MAX_SUBJECT_LENGTH = 255;
/** Keeps a pathological synopsis from bloating a 20-request batch. */
const MAX_BODY_LENGTH = 8000;

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEventPayload {
  subject: string;
  body: { contentType: 'text'; content: string };
  start: GraphDateTime;
  end: GraphDateTime;
  isAllDay: boolean;
  showAs: 'free';
  isReminderOn: false;
  categories: string[];
  transactionId?: string;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function bodyContent(event: NormalizedEvent): string {
  const parts: string[] = [];
  if (event.description) parts.push(event.description);
  if (event.url && !event.description?.includes(event.url)) parts.push(event.url);
  return truncate(parts.join('\n\n'), MAX_BODY_LENGTH);
}

/**
 * All-day events must be midnight-aligned, with `end` the day *after* the last
 * day. The parser already produces an exclusive end, so this only formats it.
 */
function boundaries(
  event: NormalizedEvent,
  timeZone: string,
): { start: GraphDateTime; end: GraphDateTime } {
  if (event.isAllDay) {
    return {
      start: { dateTime: formatAllDayBoundary(event.start), timeZone },
      end: { dateTime: formatAllDayBoundary(event.end), timeZone },
    };
  }

  return {
    start: { dateTime: formatWallTimeInZone(event.start, timeZone), timeZone },
    end: { dateTime: formatWallTimeInZone(event.end, timeZone), timeZone },
  };
}

/**
 * `showAs: "free"` and `isReminderOn: false` are load-bearing, not cosmetic.
 * Without them a busy week fills your free/busy availability with blocks that
 * make you look booked solid, and fires a reminder for every episode.
 */
export function buildCreatePayload(event: NormalizedEvent, config: Config): GraphEventPayload {
  const { start, end } = boundaries(event, config.displayTimeZone);

  return {
    subject: truncate(event.summary, MAX_SUBJECT_LENGTH),
    body: { contentType: 'text', content: bodyContent(event) },
    start,
    end,
    isAllDay: event.isAllDay,
    showAs: 'free',
    isReminderOn: false,
    categories: [config.eventCategory],
    // Server-side dedupe: if a create is retried after a network failure, Graph
    // will not produce a second event for the same transactionId.
    transactionId: event.hash,
  };
}

/**
 * The update payload is the create payload minus `transactionId`, which Graph
 * only accepts on POST.
 */
export function buildUpdatePayload(
  event: NormalizedEvent,
  config: Config,
): Omit<GraphEventPayload, 'transactionId'> {
  const { transactionId: _ignored, ...rest } = buildCreatePayload(event, config);
  return rest;
}
