// Typed writers for the two proposal-lifecycle rows that skill prose used to
// hand-assemble as JSON: `responded` and `resolved`.
//
// The other five proposal-metrics shapes (created, triage-verdict, gate-failed,
// micro-queued, micro-resolved) were already written from code in this directory;
// these two were the last ones whose schema lived in markdown. Both carry only an
// id and an enum, so argv is safe here — no stdin mode is needed, unlike the
// observation writer where the payload is free text.
//
// `ts` is stamped here rather than passed in: the `<now ISO>` placeholder callers
// used to fill produced at least three different formats in live ledgers
// (`…Z` and `…+01:00` both appear), and no caller has a reason to choose.

import path from 'node:path';
import { appendJsonlLine } from '../append-jsonl';
import { flagEq as flag } from '../cli';
import { utcISOStamp } from '../time';

const EVENT_TYPES = ['responded', 'resolved'] as const;
const RESPONDED_ACTIONS = ['accept', 'defer', 'dismiss'] as const;

type EventType = (typeof EVENT_TYPES)[number];

function metricsPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'proposal-metrics.jsonl');
}

// Field order matches the rows this ledger already carries.
function respondedEvent(proposalId: string, action: string): Record<string, unknown> {
  return { ts: utcISOStamp(), type: 'responded', proposal_id: proposalId, action };
}

function resolvedEvent(proposalId: string): Record<string, unknown> {
  return { ts: utcISOStamp(), type: 'resolved', proposal_id: proposalId };
}

function appendEvent(stateDir: string, event: Record<string, unknown>): string | null {
  return appendJsonlLine(metricsPath(stateDir), JSON.stringify(event));
}

// `rest` is argv from the event type onward. Returns a verdict token for
// proposal.ts to emit — `OK` or `ERROR|<reason>`, never a thrown error.
function run(stateDir: string, rest: string[]): string {
  const type = rest[0];
  if (!type || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return `ERROR|unknown-event-type:${type ?? ''}`;
  }

  const id = flag(rest, 'id');
  if (!id) return 'ERROR|missing-id';
  if (!/^PROP-[A-Za-z0-9._-]+$/.test(id)) return `ERROR|invalid-id:${id}`;

  const action = flag(rest, 'action');
  let event: Record<string, unknown>;

  if ((type as EventType) === 'responded') {
    if (!action) return 'ERROR|missing-action';
    if (!(RESPONDED_ACTIONS as readonly string[]).includes(action)) {
      return `ERROR|invalid-action:${action}`;
    }
    event = respondedEvent(id, action);
  } else {
    if (action) return 'ERROR|action-not-allowed:resolved';
    event = resolvedEvent(id);
  }

  const err = appendEvent(stateDir, event);
  return err ? `ERROR|${err}` : 'OK';
}

export { EVENT_TYPES, RESPONDED_ACTIONS, metricsPath, respondedEvent, resolvedEvent, appendEvent, run };
