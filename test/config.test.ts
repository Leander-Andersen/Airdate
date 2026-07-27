import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  describeIcsSource,
  loadConfig,
  secretsOf,
  type Env,
} from '../src/config.js';
import { buildFeedUrl } from '../src/ics/fetch.js';
import { createLogger, createScrubber, fingerprint, REDACTED } from '../src/log.js';

const TOKEN = 'a'.repeat(40);

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    TV_SYNC_STATE: env.TV_SYNC_STATE,
    ICS_URL: 'https://api.tvmaze.com/ical/followed',
    TARGET_UPN: 'user@example.com',
    GRAPH_TENANT_ID: 'tenant-id',
    GRAPH_CLIENT_ID: 'client-id',
    GRAPH_CLIENT_SECRET: 'client-secret-value',
    ...overrides,
  };
}

function problemsFrom(input: Env): string[] {
  try {
    loadConfig(input);
    return [];
  } catch (error) {
    return error instanceof ConfigError ? error.problems : [String(error)];
  }
}

describe('loadConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadConfig(baseEnv());

    expect(config.calendarName).toBe('TV');
    expect(config.eventCategory).toBe('TV');
    expect(config.defaultDurationMinutes).toBe(30);
    expect(config.stateRetentionDays).toBe(30);
    expect(config.recentLimit).toBe(100);
    expect(config.feedId).toBe('default');
    expect(config.debug).toBe(false);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = problemsFrom({ TV_SYNC_STATE: env.TV_SYNC_STATE });

    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join('\n')).toContain('ICS_URL');
    expect(problems.join('\n')).toContain('GRAPH_CLIENT_SECRET');
  });

  it('rejects a plaintext feed URL, which would put the token on the wire', () => {
    const problems = problemsFrom(baseEnv({ ICS_URL: 'http://api.tvmaze.com/ical/followed' }));

    expect(problems.join('\n')).toContain('https');
  });

  it('rejects a UPN that is not an address', () => {
    expect(problemsFrom(baseEnv({ TARGET_UPN: 'not-a-upn' })).join('\n')).toContain('TARGET_UPN');
  });

  it('rejects an unknown display timezone', () => {
    expect(problemsFrom(baseEnv({ DISPLAY_TIMEZONE: 'Mars/Olympus' })).join('\n')).toContain(
      'DISPLAY_TIMEZONE',
    );
  });

  it('rejects half a Cloudflare Access service token', () => {
    const problems = problemsFrom(baseEnv({ CF_ACCESS_CLIENT_ID: 'id-only' }));

    expect(problems.join('\n')).toContain('CF_ACCESS_CLIENT_ID');
  });

  it('accepts a complete Access service token', () => {
    const config = loadConfig(
      baseEnv({ CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'secret' }),
    );

    expect(config.ics.accessClientId).toBe('id');
    expect(config.ics.accessClientSecret).toBe('secret');
  });

  it('rejects a weak manual-trigger token', () => {
    const problems = problemsFrom(baseEnv({ MANUAL_TRIGGER_TOKEN: 'short' }));

    expect(problems.join('\n')).toContain('at least 32 characters');
  });

  it('accepts a strong manual-trigger token', () => {
    expect(loadConfig(baseEnv({ MANUAL_TRIGGER_TOKEN: TOKEN })).manualTriggerToken).toBe(TOKEN);
  });

  it('rejects non-numeric or negative durations', () => {
    expect(problemsFrom(baseEnv({ DEFAULT_DURATION_MINUTES: 'soon' })).join('\n')).toContain(
      'DEFAULT_DURATION_MINUTES',
    );
    expect(problemsFrom(baseEnv({ STATE_RETENTION_DAYS: '-5' })).join('\n')).toContain(
      'STATE_RETENTION_DAYS',
    );
  });

  it('rejects a feed id that is not a safe key fragment', () => {
    expect(problemsFrom(baseEnv({ FEED_ID: 'has spaces/and-slashes' })).join('\n')).toContain(
      'FEED_ID',
    );
  });

  it('rejects a plaintext alert webhook', () => {
    expect(problemsFrom(baseEnv({ ALERT_WEBHOOK_URL: 'http://hooks.invalid/x' })).join('\n')).toContain(
      'ALERT_WEBHOOK_URL',
    );
  });

  it('flags a missing KV binding', () => {
    const problems = problemsFrom({ ...baseEnv(), TV_SYNC_STATE: undefined as never });

    expect(problems.join('\n')).toContain('TV_SYNC_STATE');
  });
});

describe('feed URL handling', () => {
  it('appends the token as a query parameter', () => {
    const config = loadConfig(baseEnv({ ICS_TOKEN: 'feed-token-value' }));
    const url = buildFeedUrl(config);

    expect(url.searchParams.get('token')).toBe('feed-token-value');
  });

  it('never exposes the token through the loggable description', () => {
    const config = loadConfig(baseEnv({ ICS_TOKEN: 'feed-token-value' }));

    const described = describeIcsSource(config);
    expect(described).toBe('https://api.tvmaze.com/ical/followed');
    expect(described).not.toContain('feed-token-value');
    expect(described).not.toContain('?');
  });

  it('lists every secret for the log scrubber', () => {
    const config = loadConfig(
      baseEnv({
        ICS_TOKEN: 'feed-token-value',
        CF_ACCESS_CLIENT_ID: 'access-id',
        CF_ACCESS_CLIENT_SECRET: 'access-secret',
        MANUAL_TRIGGER_TOKEN: TOKEN,
      }),
    );

    const secrets = secretsOf(config);

    expect(secrets).toContain('client-secret-value');
    expect(secrets).toContain('feed-token-value');
    expect(secrets).toContain('access-secret');
    expect(secrets).toContain(TOKEN);
  });
});

describe('log scrubbing', () => {
  it('removes secret values from log text', () => {
    const scrub = createScrubber(['super-secret-value', 'another-secret-token']);

    const line = 'failed with url=https://x/?token=super-secret-value and another-secret-token';
    const scrubbed = scrub(line);

    expect(scrubbed).not.toContain('super-secret-value');
    expect(scrubbed).not.toContain('another-secret-token');
    expect(scrubbed).toContain(REDACTED);
  });

  it('ignores values too short to scrub safely', () => {
    const scrub = createScrubber(['ab']);

    expect(scrub('a table of absolutes')).toBe('a table of absolutes');
  });

  it('scrubs a secret that appears inside a longer one', () => {
    const scrub = createScrubber(['secret-prefix', 'secret-prefix-and-more']);

    expect(scrub('value=secret-prefix-and-more')).toBe(`value=${REDACTED}`);
  });

  it('scrubs secrets that reach the logger through nested fields', () => {
    const emitted: string[] = [];
    const original = console.log;
    console.log = (line: string) => emitted.push(line);

    try {
      const log = createLogger({ debug: false, secrets: ['client-secret-value'] });
      log.info('Graph rejected the call', {
        detail: { echoed: 'client_secret=client-secret-value' },
      });
    } finally {
      console.log = original;
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).not.toContain('client-secret-value');
    expect(emitted[0]).toContain(REDACTED);
  });

  it('suppresses debug lines unless debug is on', () => {
    const emitted: string[] = [];
    const original = console.log;
    console.log = (line: string) => emitted.push(line);

    try {
      createLogger({ debug: false }).debug('quiet');
      expect(emitted).toHaveLength(0);

      createLogger({ debug: true }).debug('loud');
      expect(emitted).toHaveLength(1);
    } finally {
      console.log = original;
    }
  });

  it('produces a short non-reversible fingerprint', async () => {
    const print = await fingerprint('client-secret-value');

    expect(print).toMatch(/^[0-9a-f]{8}$/);
    expect(await fingerprint('client-secret-value')).toBe(print);
    expect(await fingerprint('a-different-secret')).not.toBe(print);
  });
});
