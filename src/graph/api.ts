/**
 * The `CalendarApi` the sync engine talks to, implemented against Graph.
 *
 * Translates operations into batched HTTP and batched HTTP back into per-UID
 * results, so `sync.ts` never has to know about Graph's shapes.
 */

import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { CalendarApi, Operation, OperationResult } from '../sync.js';
import { executeBatch, type BatchRequest } from './batch.js';
import { CalendarResolver, explainAccessFailure } from './calendar.js';
import { buildCreatePayload, buildUpdatePayload } from './events.js';
import { describeGraphError, GraphError, type GraphContext } from './request.js';

function eventPath(upn: string, eventId: string): string {
  return `/users/${encodeURIComponent(upn)}/events/${encodeURIComponent(eventId)}`;
}

function calendarEventsPath(upn: string, calendarId: string): string {
  return `/users/${encodeURIComponent(upn)}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function createdEventId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id = (body as Record<string, unknown>)['id'];
  return typeof id === 'string' && id ? id : undefined;
}

export class GraphCalendarApi implements CalendarApi {
  private readonly resolver: CalendarResolver;

  constructor(
    private readonly ctx: GraphContext,
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.resolver = new CalendarResolver(ctx, config.graph, config.calendarName, log);
  }

  async resolveCalendarId(knownId: string | null): Promise<string> {
    return this.resolver.resolve(knownId);
  }

  async apply(calendarId: string, operations: Operation[]): Promise<OperationResult[]> {
    const upn = this.config.graph.targetUpn;

    // Sub-request ids are positional handles only; results are matched back
    // through this map, never by array position.
    const byRequestId = new Map<string, Operation>();

    const requests: BatchRequest[] = operations.map((operation, index) => {
      const id = `op-${index}`;
      byRequestId.set(id, operation);

      if (operation.kind === 'create') {
        return {
          id,
          method: 'POST',
          url: calendarEventsPath(upn, calendarId),
          body: buildCreatePayload(operation.event, this.config),
        };
      }

      if (operation.kind === 'update') {
        return {
          id,
          method: 'PATCH',
          url: eventPath(upn, operation.eventId),
          body: buildUpdatePayload(operation.event, this.config),
        };
      }

      return { id, method: 'DELETE', url: eventPath(upn, operation.eventId) };
    });

    const responses = await executeBatch(this.ctx, requests);

    return responses.map((response): OperationResult => {
      const operation = byRequestId.get(response.id);
      if (!operation) {
        // Cannot happen with ids we generated, but never guess a UID.
        this.log.error('Batch returned a sub-response with an unrecognised id', {
          id: response.id,
        });
        return { uid: '', kind: 'create', ok: false, status: response.status };
      }

      const ok = response.status >= 200 && response.status < 300;

      if (ok) {
        const result: OperationResult = {
          uid: operation.uid,
          kind: operation.kind,
          ok: true,
          status: response.status,
        };

        if (operation.kind === 'create') {
          const eventId = createdEventId(response.body);
          if (!eventId) {
            // A 2xx with no id is not something we can record; force a retry.
            this.log.error('Graph created an event but returned no id', { uid: operation.uid });
            return { uid: operation.uid, kind: 'create', ok: false, status: 502 };
          }
          result.eventId = eventId;
        }

        return result;
      }

      const { code, message } = describeGraphError(response.body);

      // 404 on update/delete is expected housekeeping, not a fault.
      if (response.status === 404 && operation.kind !== 'create') {
        this.log.debug('Event no longer exists in the calendar', {
          uid: operation.uid,
          kind: operation.kind,
        });
      } else if (response.status === 403 || response.status === 401) {
        this.log.error(
          explainAccessFailure(
            new GraphError(
              `Graph refused ${operation.kind} for ${operation.uid}`,
              response.status,
              code,
              message,
            ),
          ),
          { uid: operation.uid, status: response.status, code },
        );
      } else {
        // Graph's error bodies are genuinely informative; log them in full.
        this.log.error('Graph sub-request failed', {
          uid: operation.uid,
          kind: operation.kind,
          status: response.status,
          code,
          message,
        });
      }

      const failure: OperationResult = {
        uid: operation.uid,
        kind: operation.kind,
        ok: false,
        status: response.status,
      };
      if (message) failure.error = message;
      return failure;
    });
  }
}
