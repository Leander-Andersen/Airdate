/**
 * Timezone arithmetic built on Intl, which Workers ship with full ICU data for.
 *
 * Hard-coded UTC offsets are wrong twice a year, so every conversion here goes
 * through the IANA database via `Intl.DateTimeFormat`.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 keeps midnight as 00 rather than the 24 some locales emit.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws if the runtime does not recognise the zone. Used for config validation. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading a zone shows at a given absolute instant. */
export function wallTimeInZone(instant: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const lookup: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) lookup[part.type] = part.value;

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = lookup[type];
    if (raw === undefined) {
      throw new Error(`Intl did not return a "${type}" part for zone ${timeZone}`);
    }
    return Number(raw);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Milliseconds the zone is ahead of UTC at a given instant. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const wall = wallTimeInZone(instant, timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Intl has no sub-second precision, so compare against a second-aligned instant.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Resolve a wall-clock reading in a named zone to the absolute instant it denotes.
 *
 * Two passes: the offset itself depends on the instant we are solving for, so the
 * first pass guesses using the offset at the naive-UTC interpretation and the
 * second corrects it. That converges for every real zone, including across DST
 * transitions where the two passes disagree.
 *
 * Ambiguous times (the repeated hour when clocks go back) resolve to the first,
 * pre-transition occurrence. Nonexistent times (the skipped hour when clocks go
 * forward) resolve to the instant the same distance past the transition. Neither
 * matters for episode air times, but both are deterministic rather than throwing.
 */
export function zonedWallTimeToInstant(wall: WallTime, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  const secondPass = naive - zoneOffsetMs(new Date(firstPass), timeZone);

  return new Date(secondPass);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Format an instant as the local wall time in a zone, as Graph's
 * `dateTime` field wants it: no offset, no `Z`, paired with a `timeZone`.
 */
export function formatWallTimeInZone(instant: Date, timeZone: string): string {
  const wall = wallTimeInZone(instant, timeZone);
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  );
}

/**
 * Format an all-day boundary. All-day ICS dates carry no zone, so they are held
 * as UTC midnight and must be read back in UTC — running them through a zone
 * would shift them onto the wrong calendar day.
 */
export function formatAllDayBoundary(instant: Date): string {
  return (
    `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}` +
    `T00:00:00`
  );
}
