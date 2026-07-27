/**
 * Worker entrypoint.
 *
 * `scheduled()` is the real interface — the cron does the work. `fetch()` exists
 * only for debugging and inspection, is disabled unless MANUAL_TRIGGER_TOKEN is
 * set, and authenticates every request before it does anything at all.
 */

import { ConfigError, loadConfig, secretsOf, type Config, type Env } from './config.js';
import { GraphCalendarApi } from './graph/api.js';
import { TokenProvider } from './graph/auth.js';
import { createGraphContext } from './graph/request.js';
import { fetchIcs } from './ics/fetch.js';
import { createLogger, type Logger } from './log.js';
import { loadRecentLog, recordAdditions } from './recent.js';
import { loadState, saveState, trackedCount } from './state.js';
import { runSync, type SyncDeps, type SyncSummary } from './sync.js';

/** Minimum gap between manual syncs, so a leaked token cannot be used to hammer Graph. */
const MANUAL_SYNC_COOLDOWN_MS = 60_000;
const MANUAL_SYNC_MARKER = 'manual-sync-last-run';

function buildDeps(env: Env, config: Config, log: Logger): SyncDeps {
  const tokens = new TokenProvider(env.TV_SYNC_STATE, config.graph, log);
  const graphContext = createGraphContext(tokens, log);

  return {
    config,
    log,
    fetchFeed: () => fetchIcs(config, log),
    loadState: () => loadState(env.TV_SYNC_STATE, config.feedId, log),
    saveState: (state) => saveState(env.TV_SYNC_STATE, config.feedId, state),
    recordAdditions: (additions) =>
      recordAdditions(env.TV_SYNC_STATE, additions, config.recentLimit, log),
    calendar: new GraphCalendarApi(graphContext, config, log),
    now: () => new Date(),
  };
}

async function notifyFailure(config: Config, summary: SyncSummary, log: Logger): Promise<void> {
  if (!config.alertWebhookUrl) return;

  try {
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'airdate',
        feedId: config.feedId,
        status: summary.aborted ? 'aborted' : 'degraded',
        ...summary,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    log.warn('Could not deliver the failure alert', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function performSync(
  env: Env,
  config: Config,
  log: Logger,
  ctx: ExecutionContext,
  trigger: 'cron' | 'manual',
): Promise<SyncSummary> {
  const summary = await runSync(buildDeps(env, config, log));

  // The one summary line per run.
  const level = summary.aborted || summary.errors > 0 ? 'error' : 'info';
  log[level]('Sync complete', { trigger, feedId: config.feedId, ...summary });

  if (summary.aborted || summary.errors > 0) {
    ctx.waitUntil(notifyFailure(config, summary, log));
  }

  return summary;
}

/* ------------------------------------------------------------------ *
 * HTTP surface — debugging and inspection only.
 * ------------------------------------------------------------------ */

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // Deliberately no CORS headers: nothing here should be readable from a web page.
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: SECURITY_HEADERS });
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Digesting first means the comparison always runs over 32 fixed bytes, so
 * neither the token's length nor the position of the first differing byte is
 * observable from response timing.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);

  const x = new Uint8Array(left);
  const y = new Uint8Array(right);

  let difference = 0;
  for (let i = 0; i < x.length; i++) {
    difference |= (x[i] as number) ^ (y[i] as number);
  }
  return difference === 0;
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function authorize(request: Request, config: Config): Promise<boolean> {
  if (!config.manualTriggerToken) return false;

  const presented = presentedToken(request);
  if (!presented) return false;

  return timingSafeEqual(presented, config.manualTriggerToken);
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: Config,
  log: Logger,
): Promise<Response> {
  // With no token configured the HTTP surface does not exist at all, and answers
  // exactly as an unrouted path would, so its presence is not detectable.
  if (!config.manualTriggerToken) {
    return json({ error: 'not_found' }, 404);
  }

  if (!(await authorize(request, config))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...SECURITY_HEADERS, 'WWW-Authenticate': 'Bearer' },
    });
  }

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/recent') {
    const recent = await loadRecentLog(env.TV_SYNC_STATE, log);
    const requested = Number(url.searchParams.get('limit') ?? config.recentLimit);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 100, 1000);

    return json({ count: recent.entries.length, entries: recent.entries.slice(0, limit) });
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    const { state } = await loadState(env.TV_SYNC_STATE, config.feedId, log);

    return json({
      feedId: config.feedId,
      calendarName: config.calendarName,
      calendarResolved: state.calendarId !== null,
      trackedEvents: trackedCount(state),
      lastSyncAt: state.lastSyncAt,
    });
  }

  if (request.method === 'POST' && url.pathname === '/sync') {
    const lastRun = Number(await env.TV_SYNC_STATE.get(MANUAL_SYNC_MARKER));
    const sinceMs = Date.now() - lastRun;

    if (Number.isFinite(lastRun) && lastRun > 0 && sinceMs < MANUAL_SYNC_COOLDOWN_MS) {
      return json(
        {
          error: 'cooldown',
          retryAfterSeconds: Math.ceil((MANUAL_SYNC_COOLDOWN_MS - sinceMs) / 1000),
        },
        429,
      );
    }

    await env.TV_SYNC_STATE.put(MANUAL_SYNC_MARKER, String(Date.now()), { expirationTtl: 60 });

    const summary = await performSync(env, config, log, ctx, 'manual');
    return json(summary, summary.aborted ? 503 : 200);
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const bootstrapLog = createLogger({ debug: (env.DEBUG ?? '').toLowerCase() === 'true' });

    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      // Fail loudly and stop. Running on half a configuration is how a feed
      // token ends up somewhere it should not be.
      bootstrapLog.error('Refusing to run with invalid configuration', {
        problems: error instanceof ConfigError ? error.problems : [String(error)],
      });
      return;
    }

    const log = createLogger({ debug: config.debug, secrets: secretsOf(config) });

    try {
      await performSync(env, config, log, ctx, 'cron');
    } catch (error) {
      log.error('Sync threw an unhandled error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let config: Config;

    try {
      config = loadConfig(env);
    } catch {
      // Never echo configuration problems to an unauthenticated caller.
      return json({ error: 'not_found' }, 404);
    }

    const log = createLogger({ debug: config.debug, secrets: secretsOf(config) });

    try {
      return await handleRequest(request, env, ctx, config, log);
    } catch (error) {
      log.error('Request handler threw', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Generic body: internal detail stays in the logs.
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
