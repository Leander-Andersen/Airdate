/**
 * A purpose-built RFC 5545 reader for flat VEVENT feeds.
 *
 * These feeds (TVmaze, Sonarr, Trakt) emit one VEVENT per episode with no RRULE
 * and no recurrence expansion, which is the hard part of a general ICS library.
 * Hand-rolling avoids `node-ical`, whose Node runtime dependencies do not work
 * reliably on Workers.
 */

import { zonedWallTimeToInstant, type WallTime } from '../time.js';

export interface NormalizedEvent {
  /** ICS UID — the stable identity key across runs. */
  uid: string;
  summary: string;
  description?: string;
  url?: string;
  /** Absolute instant. */
  start: Date;
  /** Absolute instant; synthesized when DTEND and DURATION are both absent. */
  end: Date;
  /** True when DTSTART was a VALUE=DATE. */
  isAllDay: boolean;
  /** Content digest, so the sync engine can skip unchanged events. */
  hash: string;
}

export interface ParseOptions {
  /** Used when a VEVENT has neither DTEND nor DURATION. */
  defaultDurationMinutes: number;
  /**
   * Zone for "floating" times — a DTSTART with no TZID and no Z suffix. RFC 5545
   * says those mean local time wherever they are read, so we read them as the
   * calendar owner's display zone.
   */
  fallbackTimeZone: string;
}

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsParseError';
  }
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const DURATION_PATTERN = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * RFC 5545 line unfolding: a line starting with a space or tab continues the
 * previous one. Long DESCRIPTION values are folded as a matter of course, and
 * parsing without unfolding silently truncates them.
 */
function unfold(text: string): string[] {
  const lines: string[] = [];

  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (lines.length > 0 && (raw.startsWith(' ') || raw.startsWith('\t'))) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }

  return lines;
}

/** Split on a delimiter, ignoring delimiters inside double-quoted parameter values. */
function splitUnquoted(input: string, delimiter: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === delimiter && !inQuotes) {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  segments.push(current);
  return segments;
}

function parseContentLine(line: string): ContentLine | null {
  let inQuotes = false;
  let colonAt = -1;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ':' && !inQuotes) {
      colonAt = i;
      break;
    }
  }

  if (colonAt === -1) return null;

  const segments = splitUnquoted(line.slice(0, colonAt), ';');
  const name = (segments[0] ?? '').toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const equalsAt = segment.indexOf('=');
    if (equalsAt === -1) continue;

    let value = segment.slice(equalsAt + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    params[segment.slice(0, equalsAt).toUpperCase()] = value;
  }

  return { name, params, value: line.slice(colonAt + 1) };
}

/** Reverse the TEXT escaping from RFC 5545 §3.3.11. */
function unescapeText(value: string): string {
  let out = '';

  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\' || i + 1 >= value.length) {
      out += value[i];
      continue;
    }

    const next = value[++i];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === ',' || next === ';' || next === '\\') out += next;
    // An unknown escape keeps the escaped character and drops the backslash,
    // which is what every tolerant reader does.
    else out += next;
  }

  return out;
}

function parseDurationMs(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const magnitude =
    Number(weeks ?? 0) * 604_800_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000;

  return sign === '-' ? -magnitude : magnitude;
}

interface ParsedDate {
  instant: Date;
  isDateOnly: boolean;
}

/**
 * Handles the three DTSTART/DTEND forms these feeds emit:
 *   DTSTART:20260730T210000Z                    — UTC
 *   DTSTART;TZID=Europe/Oslo:20260730T210000    — wall time in a named zone
 *   DTSTART;VALUE=DATE:20260730                 — all-day
 */
function parseIcsDate(line: ContentLine, fallbackTimeZone: string): ParsedDate {
  const value = line.value.trim();
  const dateOnly = DATE_PATTERN.exec(value);

  if (dateOnly || (line.params['VALUE'] ?? '').toUpperCase() === 'DATE') {
    if (!dateOnly) {
      throw new IcsParseError(`${line.name} declared VALUE=DATE but is not YYYYMMDD: "${value}"`);
    }
    // Held as UTC midnight: an all-day date denotes a calendar day, not an instant.
    return {
      instant: new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))),
      isDateOnly: true,
    };
  }

  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) {
    throw new IcsParseError(`Unparseable ${line.name} value: "${value}"`);
  }

  const wall: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };

  if (match[7] === 'Z') {
    return {
      instant: new Date(
        Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
      ),
      isDateOnly: false,
    };
  }

  const tzid = line.params['TZID'] ?? fallbackTimeZone;
  let instant: Date;
  try {
    instant = zonedWallTimeToInstant(wall, tzid);
  } catch {
    // An unrecognised TZID should not sink the whole feed; fall back rather than throw.
    instant = zonedWallTimeToInstant(wall, fallbackTimeZone);
  }

  return { instant, isDateOnly: false };
}

/** SHA-256 over the fields that determine whether the calendar entry needs rewriting. */
export async function hashEvent(
  fields: Pick<NormalizedEvent, 'summary' | 'description' | 'url' | 'start' | 'end' | 'isAllDay'>,
): Promise<string> {
  const material = [
    fields.summary,
    fields.description ?? '',
    fields.url ?? '',
    fields.start.toISOString(),
    fields.end.toISOString(),
    String(fields.isAllDay),
  ].join('|');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface RawEvent {
  uid?: string;
  summary?: string;
  description?: string;
  url?: string;
  dtstart?: ParsedDate;
  dtend?: ParsedDate;
  durationMs?: number;
}

function finalize(raw: RawEvent, options: ParseOptions): Omit<NormalizedEvent, 'hash'> | null {
  // A VEVENT without a UID has no stable identity, so it cannot be reconciled.
  if (!raw.uid || !raw.dtstart) return null;

  const isAllDay = raw.dtstart.isDateOnly;
  const start = raw.dtstart.instant;

  let end: Date;
  if (raw.dtend) {
    end = raw.dtend.instant;
  } else if (raw.durationMs !== undefined) {
    end = new Date(start.getTime() + raw.durationMs);
  } else if (isAllDay) {
    // A single all-day day: DTEND is exclusive, so it is the following midnight.
    end = new Date(start.getTime() + 86_400_000);
  } else {
    end = new Date(start.getTime() + options.defaultDurationMinutes * 60_000);
  }

  // Defend against feeds that emit DTEND before DTSTART; Graph rejects those outright.
  if (end.getTime() < start.getTime()) {
    end = new Date(
      start.getTime() + (isAllDay ? 86_400_000 : options.defaultDurationMinutes * 60_000),
    );
  }

  const event: Omit<NormalizedEvent, 'hash'> = {
    uid: raw.uid,
    summary: raw.summary ?? '(untitled)',
    start,
    end,
    isAllDay,
  };

  if (raw.description) event.description = raw.description;
  if (raw.url) event.url = raw.url;

  return event;
}

/**
 * Parse an ICS document into normalized events, newest parse wins on duplicate UIDs.
 * Unknown properties are ignored rather than treated as errors.
 */
export async function parseIcs(text: string, options: ParseOptions): Promise<NormalizedEvent[]> {
  const byUid = new Map<string, Omit<NormalizedEvent, 'hash'>>();

  let current: RawEvent | null = null;

  for (const line of unfold(text)) {
    if (!line.trim()) continue;

    const parsed = parseContentLine(line);
    if (!parsed) continue;

    if (parsed.name === 'BEGIN' && parsed.value.trim().toUpperCase() === 'VEVENT') {
      current = {};
      continue;
    }

    if (parsed.name === 'END' && parsed.value.trim().toUpperCase() === 'VEVENT') {
      if (current) {
        const event = finalize(current, options);
        if (event) byUid.set(event.uid, event);
      }
      current = null;
      continue;
    }

    if (!current) continue;

    switch (parsed.name) {
      case 'UID':
        current.uid = unescapeText(parsed.value).trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(parsed.value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(parsed.value).trim();
        break;
      case 'URL':
        current.url = unescapeText(parsed.value).trim();
        break;
      case 'DTSTART':
        current.dtstart = parseIcsDate(parsed, options.fallbackTimeZone);
        break;
      case 'DTEND':
        current.dtend = parseIcsDate(parsed, options.fallbackTimeZone);
        break;
      case 'DURATION': {
        const ms = parseDurationMs(parsed.value);
        if (ms !== null) current.durationMs = ms;
        break;
      }
      default:
        break; // Unknown properties are not errors.
    }
  }

  return Promise.all(
    [...byUid.values()].map(async (event) => ({ ...event, hash: await hashEvent(event) })),
  );
}
