/**
 * Environment parsing and validation.
 *
 * Every problem is collected and reported in one throw rather than failing on the
 * first, so a misconfigured deployment tells you everything that is wrong in a
 * single log line instead of one item per hourly run. Error messages name the
 * offending variable but never quote its value.
 */

import { isValidTimeZone } from './time.js';

export interface Env {
  TV_SYNC_STATE: KVNamespace;

  // Plaintext vars, from wrangler.toml.
  ICS_URL?: string;
  TARGET_UPN?: string;
  CALENDAR_NAME?: string;
  EVENT_CATEGORY?: string;
  DEFAULT_DURATION_MINUTES?: string;
  DISPLAY_TIMEZONE?: string;
  STATE_RETENTION_DAYS?: string;
  RECENT_LIMIT?: string;
  FEED_ID?: string;
  DEBUG?: string;

  // Secrets, from `wrangler secret put`.
  ICS_TOKEN?: string;
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  MANUAL_TRIGGER_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
}

export interface IcsSourceConfig {
  /** Base URL with no credentials attached. Safe to log. */
  baseUrl: string;
  /** Query token appended at request time, if the source uses one. */
  token?: string;
  /** Cloudflare Access service token, for a tunnelled private source. */
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  targetUpn: string;
}

export interface Config {
  /** Scopes this feed's KV state. Lets additional feeds be added without migration. */
  feedId: string;
  ics: IcsSourceConfig;
  graph: GraphConfig;
  calendarName: string;
  eventCategory: string;
  defaultDurationMinutes: number;
  displayTimeZone: string;
  stateRetentionDays: number;
  /** How many recent additions to retain in the inspectable log. */
  recentLimit: number;
  debug: boolean;
  /** When set, enables the authenticated debug/inspection endpoints. */
  manualTriggerToken?: string;
  alertWebhookUrl?: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const UPN_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredString(
  value: string | undefined,
  name: string,
  problems: string[],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    problems.push(`${name} is required but missing or empty`);
    return undefined;
  }
  return trimmed;
}

function positiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  problems: string[],
): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive whole number`);
    return fallback;
  }
  return parsed;
}

function optionalSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  if (!env.TV_SYNC_STATE) {
    problems.push('TV_SYNC_STATE KV binding is not bound to this Worker');
  }

  const icsUrl = requiredString(env.ICS_URL, 'ICS_URL', problems);
  if (icsUrl) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(icsUrl);
    } catch {
      problems.push('ICS_URL is not a valid URL');
    }
    if (parsed && parsed.protocol !== 'https:') {
      // A feed token in a cleartext request is a token on the wire.
      problems.push('ICS_URL must use https so the feed token is never sent in cleartext');
    }
  }

  const targetUpn = requiredString(env.TARGET_UPN, 'TARGET_UPN', problems);
  if (targetUpn && !UPN_PATTERN.test(targetUpn)) {
    problems.push('TARGET_UPN does not look like a user principal name (user@domain.tld)');
  }

  const tenantId = requiredString(env.GRAPH_TENANT_ID, 'GRAPH_TENANT_ID', problems);
  const clientId = requiredString(env.GRAPH_CLIENT_ID, 'GRAPH_CLIENT_ID', problems);
  const clientSecret = requiredString(env.GRAPH_CLIENT_SECRET, 'GRAPH_CLIENT_SECRET', problems);

  const displayTimeZone = env.DISPLAY_TIMEZONE?.trim() || 'UTC';
  if (!isValidTimeZone(displayTimeZone)) {
    problems.push(`DISPLAY_TIMEZONE is not an IANA zone this runtime recognises`);
  }

  const accessClientId = optionalSecret(env.CF_ACCESS_CLIENT_ID);
  const accessClientSecret = optionalSecret(env.CF_ACCESS_CLIENT_SECRET);
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    // Half a service token yields a 403 from Access that looks like a feed outage.
    problems.push(
      'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together or not at all',
    );
  }

  const alertWebhookUrl = optionalSecret(env.ALERT_WEBHOOK_URL);
  if (alertWebhookUrl) {
    try {
      const parsed = new URL(alertWebhookUrl);
      if (parsed.protocol !== 'https:') {
        problems.push('ALERT_WEBHOOK_URL must use https');
      }
    } catch {
      problems.push('ALERT_WEBHOOK_URL is not a valid URL');
    }
  }

  const manualTriggerToken = optionalSecret(env.MANUAL_TRIGGER_TOKEN);
  if (manualTriggerToken && manualTriggerToken.length < 32) {
    // This token is the only thing standing in front of a public endpoint that
    // can trigger a sync and read back sync history.
    problems.push('MANUAL_TRIGGER_TOKEN must be at least 32 characters');
  }

  const feedId = (env.FEED_ID?.trim() || 'default').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(feedId)) {
    problems.push('FEED_ID must be 1-64 characters of [a-z0-9_-] and start alphanumeric');
  }

  const defaultDurationMinutes = positiveInt(
    env.DEFAULT_DURATION_MINUTES,
    'DEFAULT_DURATION_MINUTES',
    30,
    problems,
  );
  const stateRetentionDays = positiveInt(
    env.STATE_RETENTION_DAYS,
    'STATE_RETENTION_DAYS',
    30,
    problems,
  );
  const recentLimit = positiveInt(env.RECENT_LIMIT, 'RECENT_LIMIT', 100, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  const ics: IcsSourceConfig = { baseUrl: icsUrl! };
  const icsToken = optionalSecret(env.ICS_TOKEN);
  if (icsToken) ics.token = icsToken;
  if (accessClientId) ics.accessClientId = accessClientId;
  if (accessClientSecret) ics.accessClientSecret = accessClientSecret;

  const config: Config = {
    feedId,
    ics,
    graph: {
      tenantId: tenantId!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      targetUpn: targetUpn!,
    },
    calendarName: env.CALENDAR_NAME?.trim() || 'TV',
    eventCategory: env.EVENT_CATEGORY?.trim() || 'TV',
    defaultDurationMinutes,
    displayTimeZone,
    stateRetentionDays,
    recentLimit,
    debug: (env.DEBUG ?? '').trim().toLowerCase() === 'true',
  };

  if (manualTriggerToken) config.manualTriggerToken = manualTriggerToken;
  if (alertWebhookUrl) config.alertWebhookUrl = alertWebhookUrl;

  return config;
}

/** Every secret value in play, for the log scrubber. */
export function secretsOf(config: Config): string[] {
  return [
    config.graph.clientSecret,
    config.ics.token,
    config.ics.accessClientSecret,
    config.ics.accessClientId,
    config.manualTriggerToken,
    config.alertWebhookUrl,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Origin and path only — never the query string, which is where feed tokens live. */
export function describeIcsSource(config: Config): string {
  try {
    const parsed = new URL(config.ics.baseUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparseable ICS_URL)';
  }
}
