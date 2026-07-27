/**
 * Target calendar resolution: verify, find, or create.
 *
 * Everything is written to a dedicated calendar rather than the default one, so
 * a bad run can be undone by deleting a single calendar and nothing the user
 * actually put in their diary is ever at risk.
 */

import type { GraphConfig } from '../config.js';
import type { Logger } from '../log.js';
import { GraphError, graphRequest, type GraphContext } from './request.js';

interface CalendarSummary {
  id: string;
  name: string;
}

function readCalendars(payload: unknown): CalendarSummary[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const value = (payload as Record<string, unknown>)['value'];
  if (!Array.isArray(value)) return [];

  const calendars: CalendarSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] === 'string' && typeof record['name'] === 'string') {
      calendars.push({ id: record['id'], name: record['name'] });
    }
  }
  return calendars;
}

function userPath(graph: GraphConfig): string {
  return `/users/${encodeURIComponent(graph.targetUpn)}`;
}

/** Turn Graph's 403 into the diagnosis it almost always deserves. */
export function explainAccessFailure(error: GraphError): string {
  if (error.status !== 403) return error.message;

  return (
    `${error.message} — this is a configuration fault, not a transient one. ` +
    'Check that admin consent was granted for Calendars.ReadWrite (Application), ' +
    'and that the ApplicationAccessPolicy has finished propagating; that can take ' +
    'up to an hour, and Test-ApplicationAccessPolicy reports Granted before Graph honours it.'
  );
}

export class CalendarResolver {
  constructor(
    private readonly ctx: GraphContext,
    private readonly graph: GraphConfig,
    private readonly calendarName: string,
    private readonly log: Logger,
  ) {}

  /**
   * Resolve the calendar id, preferring the one already in state.
   *
   * A stored id is verified rather than trusted: the user may have deleted the
   * calendar between runs, and writing events against a dead id fails on every
   * single one.
   */
  async resolve(knownId: string | null): Promise<string> {
    if (knownId) {
      const verified = await this.verify(knownId);
      if (verified) return knownId;
      this.log.warn('Stored calendar id no longer exists; re-resolving by name');
    }

    const existing = await this.findByName();
    if (existing) {
      this.log.debug('Matched the target calendar by name', { calendarId: existing });
      return existing;
    }

    return this.create();
  }

  private async verify(calendarId: string): Promise<boolean> {
    try {
      await graphRequest(
        this.ctx,
        'GET',
        `${userPath(this.graph)}/calendars/${encodeURIComponent(calendarId)}?$select=id`,
      );
      return true;
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return false;
      if (error instanceof GraphError && error.isConfigurationFault) {
        this.log.error(explainAccessFailure(error), { status: error.status, code: error.code });
      }
      throw error;
    }
  }

  private async findByName(): Promise<string | null> {
    try {
      const { body } = await graphRequest(
        this.ctx,
        'GET',
        `${userPath(this.graph)}/calendars?$select=id,name&$top=100`,
      );

      const match = readCalendars(body).find((calendar) => calendar.name === this.calendarName);
      return match ? match.id : null;
    } catch (error) {
      if (error instanceof GraphError && error.isConfigurationFault) {
        this.log.error(explainAccessFailure(error), { status: error.status, code: error.code });
      }
      throw error;
    }
  }

  private async create(): Promise<string> {
    this.log.info('Creating the target calendar', { name: this.calendarName });

    const { body } = await graphRequest(this.ctx, 'POST', `${userPath(this.graph)}/calendars`, {
      name: this.calendarName,
    });

    const id = typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['id']
      : undefined;

    if (typeof id !== 'string' || !id) {
      throw new GraphError('Calendar creation returned no id', 502);
    }

    return id;
  }
}
