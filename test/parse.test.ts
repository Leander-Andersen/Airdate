import { describe, expect, it } from 'vitest';

import { hashEvent, IcsParseError, parseIcs, type NormalizedEvent } from '../src/ics/parse.js';
import tvmazeFixture from './fixtures/tvmaze.ics?raw';
import sonarrFixture from './fixtures/sonarr.ics?raw';

const OPTIONS = { defaultDurationMinutes: 30, fallbackTimeZone: 'Europe/Oslo' };

function byUid(events: NormalizedEvent[]): Map<string, NormalizedEvent> {
  return new Map(events.map((event) => [event.uid, event]));
}

function required(events: Map<string, NormalizedEvent>, uid: string): NormalizedEvent {
  const event = events.get(uid);
  if (!event) throw new Error(`fixture is missing expected UID ${uid}`);
  return event;
}

describe('parseIcs — TVmaze fixture', () => {
  it('parses every VEVENT', async () => {
    const events = await parseIcs(tvmazeFixture, OPTIONS);
    expect(events).toHaveLength(4);
  });

  it('unfolds continuation lines instead of truncating them', async () => {
    const event = required(byUid(await parseIcs(tvmazeFixture, OPTIONS)), 'tvmaze-episode-2634518');

    // "un" + fold + " make" must rejoin as "unmake", not "un make" or "un".
    expect(event.description).toContain('he cannot unmake');
    expect(event.description).toContain('a new mandate from the board');
    expect(event.description).toContain(
      'https://www.tvmaze.com/episodes/2634518/severance-2x05-trojans-horse',
    );
    expect(event.description).not.toContain('\n ');
  });

  it('decodes escape sequences', async () => {
    const events = byUid(await parseIcs(tvmazeFixture, OPTIONS));

    // \n becomes a real newline, \, becomes a comma.
    expect(required(events, 'tvmaze-episode-2634518').description).toContain(
      'the board.\n\nhttps://',
    );
    expect(required(events, 'tvmaze-episode-2634521').description).toBe(
      'Five comedians attempt tasks, badly.',
    );
    // \; becomes a semicolon.
    expect(required(events, 'tvmaze-episode-2634520').description).toBe(
      'Season premiere. Release date only; no confirmed air time.',
    );
  });

  it('reads a UTC DTSTART/DTEND pair as absolute instants', async () => {
    const event = required(byUid(await parseIcs(tvmazeFixture, OPTIONS)), 'tvmaze-episode-2634518');

    expect(event.start.toISOString()).toBe('2026-07-30T21:00:00.000Z');
    expect(event.end.toISOString()).toBe('2026-07-30T21:45:00.000Z');
    expect(event.isAllDay).toBe(false);
    expect(event.summary).toBe("Severance - S02E05 - Trojan's Horse");
    expect(event.url).toBe('https://www.tvmaze.com/episodes/2634518/severance-2x05-trojans-horse');
  });

  it('synthesizes DTEND from the default duration when absent', async () => {
    const event = required(byUid(await parseIcs(tvmazeFixture, OPTIONS)), 'tvmaze-episode-2634519');

    expect(event.start.toISOString()).toBe('2026-07-31T02:00:00.000Z');
    expect(event.end.toISOString()).toBe('2026-07-31T02:30:00.000Z');
  });

  it('honours a caller-supplied default duration', async () => {
    const events = await parseIcs(tvmazeFixture, { ...OPTIONS, defaultDurationMinutes: 45 });
    const event = required(byUid(events), 'tvmaze-episode-2634519');

    expect(event.end.toISOString()).toBe('2026-07-31T02:45:00.000Z');
  });

  it('flags VALUE=DATE events as all-day on UTC midnight boundaries', async () => {
    const event = required(byUid(await parseIcs(tvmazeFixture, OPTIONS)), 'tvmaze-episode-2634520');

    expect(event.isAllDay).toBe(true);
    expect(event.start.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    // DTEND is exclusive: the day after the last day.
    expect(event.end.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('ignores unknown X- properties rather than failing', async () => {
    const event = required(byUid(await parseIcs(tvmazeFixture, OPTIONS)), 'tvmaze-episode-2634521');

    expect(event.summary).toBe('Taskmaster - S21E04 - A Terrible Pea');
    expect(event.url).toBeUndefined();
  });
});

describe('parseIcs — Sonarr fixture', () => {
  it('parses every VEVENT and ignores the VTIMEZONE block', async () => {
    const events = await parseIcs(sonarrFixture, OPTIONS);
    expect(events).toHaveLength(5);
  });

  it('resolves TZID wall times correctly on both sides of a DST boundary', async () => {
    const events = byUid(await parseIcs(sonarrFixture, OPTIONS));

    // 2026-03-29 is the night Europe/Oslo springs forward at 02:00 CET -> 03:00 CEST.
    // 01:00 is still CET (+01:00); 04:00 is already CEST (+02:00). A hard-coded
    // offset would get one of these two wrong.
    const beforeTransition = required(events, 'NzY5MS0xMDE=');
    expect(beforeTransition.start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(beforeTransition.end.toISOString()).toBe('2026-03-29T00:45:00.000Z');

    const afterTransition = required(events, 'NzY5MS0xMDI=');
    expect(afterTransition.start.toISOString()).toBe('2026-03-29T02:00:00.000Z');
    expect(afterTransition.end.toISOString()).toBe('2026-03-29T02:45:00.000Z');

    // The same wall-clock hour on the two sides is three hours apart in real time,
    // not the two hours a naive reading would give.
    const gapMs = afterTransition.start.getTime() - beforeTransition.start.getTime();
    expect(gapMs).toBe(2 * 60 * 60 * 1000);
  });

  it('resolves a wall time after the autumn transition back to standard time', async () => {
    const event = required(byUid(await parseIcs(sonarrFixture, OPTIONS)), 'NzY5MS0xMDM=');

    // 2026-10-25 12:00 in Oslo is CET (+01:00) — DST ended that morning.
    expect(event.start.toISOString()).toBe('2026-10-25T11:00:00.000Z');
  });

  it('applies DURATION when DTEND is absent', async () => {
    const event = required(byUid(await parseIcs(sonarrFixture, OPTIONS)), 'NzY5MS0xMDM=');

    expect(event.end.toISOString()).toBe('2026-10-25T11:50:00.000Z');
  });

  it('parses a summer TZID event at the +02:00 offset', async () => {
    const event = required(byUid(await parseIcs(sonarrFixture, OPTIONS)), 'NzY5MS0xMDU=');

    expect(event.start.toISOString()).toBe('2026-09-01T18:30:00.000Z');
    expect(event.end.toISOString()).toBe('2026-09-01T19:00:00.000Z');
  });

  it('handles a Sonarr all-day entry', async () => {
    const event = required(byUid(await parseIcs(sonarrFixture, OPTIONS)), 'NzY5MS0xMDQ=');

    expect(event.isAllDay).toBe(true);
    expect(event.start.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(event.end.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });
});

describe('parseIcs — edge cases', () => {
  const wrap = (body: string) =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

  it('returns an empty array for a feed with no events', async () => {
    expect(await parseIcs(wrap(''), OPTIONS)).toEqual([]);
    expect(await parseIcs('', OPTIONS)).toEqual([]);
  });

  it('accepts CRLF, LF and folded tabs alike', async () => {
    const lf = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20260101T000000Z\nSUMMARY:One\n\tTwo\nEND:VEVENT\nEND:VCALENDAR';
    const [event] = await parseIcs(lf, OPTIONS);

    expect(event?.summary).toBe('OneTwo');
  });

  it('drops VEVENTs with no UID, since they cannot be reconciled', async () => {
    const events = await parseIcs(
      wrap('BEGIN:VEVENT\r\nSUMMARY:Anonymous\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT'),
      OPTIONS,
    );

    expect(events).toEqual([]);
  });

  it('drops VEVENTs with no DTSTART', async () => {
    const events = await parseIcs(
      wrap('BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Undated\r\nEND:VEVENT'),
      OPTIONS,
    );

    expect(events).toEqual([]);
  });

  it('reads a floating DTSTART in the configured fallback zone', async () => {
    const events = await parseIcs(
      wrap('BEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20260701T120000\r\nEND:VEVENT'),
      OPTIONS,
    );

    // July in Oslo is CEST (+02:00).
    expect(events[0]?.start.toISOString()).toBe('2026-07-01T10:00:00.000Z');
  });

  it('falls back to the configured zone when TZID is unrecognised', async () => {
    const events = await parseIcs(
      wrap(
        'BEGIN:VEVENT\r\nUID:badzone\r\nDTSTART;TZID=Mars/Olympus:20260701T120000\r\nEND:VEVENT',
      ),
      OPTIONS,
    );

    expect(events[0]?.start.toISOString()).toBe('2026-07-01T10:00:00.000Z');
  });

  it('parses quoted parameter values containing a colon', async () => {
    const events = await parseIcs(
      wrap('BEGIN:VEVENT\r\nUID:q\r\nDTSTART;TZID="Europe/Oslo":20260701T120000\r\nEND:VEVENT'),
      OPTIONS,
    );

    expect(events[0]?.start.toISOString()).toBe('2026-07-01T10:00:00.000Z');
  });

  it('repairs a DTEND that precedes DTSTART', async () => {
    const events = await parseIcs(
      wrap(
        'BEGIN:VEVENT\r\nUID:backwards\r\nDTSTART:20260701T120000Z\r\nDTEND:20260701T110000Z\r\nEND:VEVENT',
      ),
      OPTIONS,
    );

    expect(events[0]?.end.toISOString()).toBe('2026-07-01T12:30:00.000Z');
  });

  it('throws IcsParseError on a malformed date value', async () => {
    await expect(
      parseIcs(wrap('BEGIN:VEVENT\r\nUID:bad\r\nDTSTART:not-a-date\r\nEND:VEVENT'), OPTIONS),
    ).rejects.toBeInstanceOf(IcsParseError);
  });

  it('keeps the last VEVENT when a UID repeats', async () => {
    const events = await parseIcs(
      wrap(
        'BEGIN:VEVENT\r\nUID:dupe\r\nSUMMARY:First\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\n' +
          'BEGIN:VEVENT\r\nUID:dupe\r\nSUMMARY:Second\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT',
      ),
      OPTIONS,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Second');
  });
});

describe('hashEvent', () => {
  const base = {
    summary: 'Severance - S02E05',
    description: 'A synopsis',
    url: 'https://example.invalid/e/1',
    start: new Date('2026-07-30T21:00:00Z'),
    end: new Date('2026-07-30T21:45:00Z'),
    isAllDay: false,
  };

  it('produces a stable hex SHA-256', async () => {
    const first = await hashEvent(base);
    const second = await hashEvent({ ...base });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes when any hashed field changes', async () => {
    const original = await hashEvent(base);

    for (const mutation of [
      { summary: 'Different' },
      { description: 'Different' },
      { url: 'https://example.invalid/e/2' },
      { start: new Date('2026-07-30T22:00:00Z') },
      { end: new Date('2026-07-30T22:45:00Z') },
      { isAllDay: true },
    ]) {
      expect(await hashEvent({ ...base, ...mutation })).not.toBe(original);
    }
  });

  it('distinguishes an absent field from an empty one at the delimiter', async () => {
    const withUrl = await hashEvent({ ...base, description: 'a', url: 'b' });
    const shifted = await hashEvent({ ...base, description: 'a|b', url: undefined });

    expect(withUrl).not.toBe(shifted);
  });
});
