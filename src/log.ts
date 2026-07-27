/**
 * Structured JSON logging with secret scrubbing.
 *
 * Worker logs are readable by anyone with dashboard access and are shipped to
 * whatever tail consumer is attached, so they are treated as a low-trust sink.
 * Every line is serialized then scrubbed of known secret values before it is
 * emitted — belt and braces against a Graph error body or a fetch failure
 * quoting back a URL that carries a token.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /** Emit debug-level lines. Driven by the DEBUG var. */
  debug: boolean;
  /** Literal secret values to scrub from every emitted line. */
  secrets?: readonly string[];
}

export const REDACTED = '[redacted]';

/**
 * Short, non-reversible identifier for a secret, safe to log or show in a UI.
 * Lets you confirm *which* credential is loaded without disclosing it.
 */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a scrubber over the given secrets. Values shorter than 8 characters are
 * skipped: they are too likely to occur incidentally, and blanket-replacing them
 * would mangle unrelated log text without meaningfully protecting anything.
 */
export function createScrubber(secrets: readonly string[]): (text: string) => string {
  const meaningful = [...new Set(secrets.filter((secret) => secret.length >= 8))]
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);

  if (meaningful.length === 0) return (text) => text;

  const pattern = new RegExp(meaningful.map(escapeForRegExp).join('|'), 'g');
  return (text) => text.replace(pattern, REDACTED);
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions): Logger {
  const scrub = createScrubber(options.secrets ?? []);
  const threshold = options.debug ? LEVEL_ORDER.debug : LEVEL_ORDER.info;

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    let line: string;
    try {
      line = JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...fields,
      });
    } catch {
      // A field with a circular reference must not take the run down.
      line = JSON.stringify({ level, time: new Date().toISOString(), message });
    }

    const scrubbed = scrub(line);
    if (level === 'error') console.error(scrubbed);
    else if (level === 'warn') console.warn(scrubbed);
    else console.log(scrubbed);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** A logger that discards everything. Useful in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
