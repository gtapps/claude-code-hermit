// ha-update-check — filter the update.* domain out of an HA states snapshot
// and classify each pending update into a tier for proposal fan-out.

export type UpdateTier = 'core' | 'os' | 'supervisor' | 'addon' | 'hacs';

export interface PendingUpdate {
  entity_id: string;
  title: string;
  installed_version: string | null;
  latest_version: string | null;
  release_summary: string | null;
  release_url: string | null;
  tier: UpdateTier;
}

const CORE_ENTITY_ID = 'update.home_assistant_core_update';
const OS_ID_PATTERN = /operating_system/;
const SUPERVISOR_ID_PATTERN = /supervisor/;

/**
 * Classify an update.* entity into a tier. Well-known Core/OS/Supervisor
 * entity_ids are the fast path; everything else needs the entity registry's
 * `platform` field (not fetched here — a live WS call per daily check is
 * more machinery than this check's value justifies) to tell add-ons
 * (`hassio`) apart from HACS/other integrations. Absent that, unknown
 * entities default to the aggregated `hacs` bucket rather than risking
 * proposal spam for anything we can't confidently call high-signal.
 */
export function classifyUpdateEntity(entityId: string, platform?: string | null): UpdateTier {
  if (entityId === CORE_ENTITY_ID) return 'core';
  if (OS_ID_PATTERN.test(entityId)) return 'os';
  if (SUPERVISOR_ID_PATTERN.test(entityId)) return 'supervisor';
  if (platform === 'hassio') return 'addon';
  return 'hacs';
}

/**
 * Filter a states snapshot down to pending update.* entities, honoring HA's
 * native skipped_version so operator-dismissed updates in the HA UI stay quiet.
 */
export function collectPendingUpdates(
  states: Array<Record<string, any>>,
  platforms: Record<string, string> = {},
): PendingUpdate[] {
  const out: PendingUpdate[] = [];
  for (const s of states) {
    const entityId = s?.entity_id;
    if (typeof entityId !== 'string' || !entityId.startsWith('update.')) continue;
    if (s.state !== 'on') continue;
    const attrs = s.attributes ?? {};
    const latest = typeof attrs.latest_version === 'string' ? attrs.latest_version : null;
    const skipped = typeof attrs.skipped_version === 'string' ? attrs.skipped_version : null;
    if (skipped !== null && skipped === latest) continue;
    out.push({
      entity_id: entityId,
      title: attrs.title ?? attrs.friendly_name ?? entityId,
      installed_version: typeof attrs.installed_version === 'string' ? attrs.installed_version : null,
      latest_version: latest,
      release_summary: typeof attrs.release_summary === 'string' ? attrs.release_summary : null,
      release_url: typeof attrs.release_url === 'string' ? attrs.release_url : null,
      tier: classifyUpdateEntity(entityId, platforms[entityId] ?? null),
    });
  }
  out.sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  return out;
}

/** Produce the scheduled-check stdout block in the documented shape. */
export function formatUpdatesStdout(updates: PendingUpdate[], dateStr: string): string {
  const header = `ha-update-check findings — ${dateStr}`;
  if (updates.length === 0) {
    return `${header}\nNo actionable findings. (no updates pending)`;
  }
  const individual = updates.filter((u) => u.tier !== 'hacs');
  const hacs = updates.filter((u) => u.tier === 'hacs');
  const lines = [header, `Updates pending: ${updates.length}`];
  for (const u of individual) {
    const url = u.release_url ? ` — ${u.release_url}` : '';
    const from = u.installed_version ?? '?';
    const to = u.latest_version ?? '?';
    lines.push(`- [${u.tier}] ${u.title}: ${from} → ${to}${url}`);
  }
  if (hacs.length > 0) {
    lines.push(`- [hacs] ${hacs.length} HACS update${hacs.length === 1 ? '' : 's'} pending`);
  }
  return lines.join('\n');
}
