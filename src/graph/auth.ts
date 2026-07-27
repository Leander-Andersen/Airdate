/**
 * Client-credentials token acquisition, cached in KV.
 *
 * Tokens last about an hour. Fetching one per run would be a needless round trip
 * and an extra chance to trip Entra's own rate limits, so the token is cached and
 * only refreshed when less than five minutes of life remain.
 *
 * The cache key is bound to a fingerprint of the client secret, so rotating the
 * secret invalidates the cached token automatically rather than leaving a run
 * failing against a token minted with the old credential.
 */

import type { GraphConfig } from '../config.js';
import { fingerprint, type Logger } from '../log.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Never cache for longer than this, whatever Entra claims. */
const MAX_CACHE_SECONDS = 3600;
/** KV rejects a TTL below 60 seconds. */
const MIN_CACHE_SECONDS = 60;

interface CachedToken {
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
}

export class GraphAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphAuthError';
  }
}

function isCachedToken(value: unknown): value is CachedToken {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['accessToken'] === 'string' &&
    candidate['accessToken'].length > 0 &&
    typeof candidate['expiresAt'] === 'number' &&
    Number.isFinite(candidate['expiresAt'])
  );
}

export class TokenProvider {
  /** Memoised for the lifetime of one run, so a batch of calls shares one lookup. */
  private inFlight: Promise<string> | null = null;
  private cacheKeyPromise: Promise<string> | null = null;

  constructor(
    private readonly kv: KVNamespace,
    private readonly config: GraphConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {}

  private cacheKey(): Promise<string> {
    this.cacheKeyPromise ??= fingerprint(this.config.clientSecret).then(
      (secretPrint) => `graph-token:${this.config.clientId}:${secretPrint}`,
    );
    return this.cacheKeyPromise;
  }

  async get(): Promise<string> {
    this.inFlight ??= this.resolve().catch((error: unknown) => {
      // Do not memoise a failure; the next attempt should try again.
      this.inFlight = null;
      throw error;
    });
    return this.inFlight;
  }

  /** Forget the cached token. Called after a 401, in case the token was revoked early. */
  async invalidate(): Promise<void> {
    this.inFlight = null;
    try {
      await this.kv.delete(await this.cacheKey());
    } catch (error) {
      this.log.warn('Could not clear the cached Graph token', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolve(): Promise<string> {
    const key = await this.cacheKey();

    let cached: unknown;
    try {
      cached = await this.kv.get(key, 'json');
    } catch {
      cached = null; // A corrupt cache entry just means we mint a new token.
    }

    if (isCachedToken(cached) && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) {
      this.log.debug('Reusing cached Graph token', {
        expiresInSeconds: Math.round((cached.expiresAt - this.now()) / 1000),
      });
      return cached.accessToken;
    }

    const token = await this.requestToken();

    const ttlSeconds = Math.max(
      MIN_CACHE_SECONDS,
      Math.min(MAX_CACHE_SECONDS, Math.floor((token.expiresAt - this.now()) / 1000)),
    );

    try {
      await this.kv.put(key, JSON.stringify(token), { expirationTtl: ttlSeconds });
    } catch (error) {
      // A failed cache write costs a round trip next run, nothing more.
      this.log.warn('Could not cache the Graph token', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return token.accessToken;
  }

  private async requestToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(
      this.config.tenantId,
    )}/oauth2/v2.0/token`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new GraphAuthError(
        `Token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      // Entra's error body names the problem (bad secret, wrong tenant, consent
      // missing) and contains no credential material, so it is worth surfacing.
      const detail = await response.text().catch(() => '');
      throw new GraphAuthError(
        `Token request failed with ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GraphAuthError('Token endpoint returned a non-JSON body');
    }

    const record = payload as Record<string, unknown>;
    const accessToken = record['access_token'];
    const expiresIn = record['expires_in'];

    if (typeof accessToken !== 'string' || !accessToken) {
      throw new GraphAuthError('Token response contained no access_token');
    }

    const lifetimeSeconds =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn
        : MAX_CACHE_SECONDS;

    this.log.debug('Acquired a new Graph token', { lifetimeSeconds });

    return { accessToken, expiresAt: this.now() + lifetimeSeconds * 1000 };
  }
}
