// lib/micro-proposals-io.ts — shared reader for state/micro-proposals.json.
// Corrupt JSON must never be silently treated as empty (issue 649: a hand-edit
// trailing comma left the file unparseable and every reader flattened that to
// an empty queue, dropping the pending backlog). Missing file is distinct from
// corrupt file: distinguished via existsSync, not a catch-all try/catch, so a
// permission/IO error on an existing file surfaces as `corrupt`, not `missing`.

import fs from 'node:fs';

type Json = any;

export type MicroProposalsRead =
  | { status: 'ok'; data: Json }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };

export function readMicroProposals(microPath: string): MicroProposalsRead {
  if (!fs.existsSync(microPath)) return { status: 'missing' };
  let data: Json;
  try {
    data = JSON.parse(fs.readFileSync(microPath, 'utf-8'));
  } catch (e: any) {
    return { status: 'corrupt', error: `micro-proposals.json is unparseable (${e.message})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'corrupt', error: 'micro-proposals.json is not a JSON object' };
  }
  // A parseable object with no `pending` key at all (a hand-seeded `{}`, or the
  // pre-1.0 `{"active": null}` shape on an install that never ran the migration)
  // holds no backlog to destroy, so heal it to an empty queue instead of wedging
  // every future queue/resolve on a hard failure. Other keys are preserved.
  if (data.pending === undefined || data.pending === null) {
    return { status: 'ok', data: { ...data, pending: [] } };
  }
  if (!Array.isArray(data.pending)) {
    return { status: 'corrupt', error: 'micro-proposals.json `pending` is not an array' };
  }
  return { status: 'ok', data };
}
