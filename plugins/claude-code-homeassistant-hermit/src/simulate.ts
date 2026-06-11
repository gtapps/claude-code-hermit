// WP7 tier 2 PARTIAL port of src/ha_agent_lab/simulate.py: only
// collect_references, which audits.ts imports (matching the Python import
// direction). Tier 3 completes this module (simulateArtifact,
// evaluateYamlPolicy, loadInventory, writeSimulationReport) and translates
// tests/test_simulate.py.

/** Walk a YAML tree once and return [entityIds, services]. */
export function collectReferences(value: unknown): [string[], string[]] {
  const entities: string[] = [];
  const services: string[] = [];
  walkReferences(value, entities, services);
  return [entities, services];
}

function pushEntityValue(child: unknown, entities: string[]): void {
  if (typeof child === 'string') {
    entities.push(...child.split(',').map((part) => part.trim()).filter(Boolean));
  } else if (Array.isArray(child)) {
    entities.push(...child.filter((item): item is string => typeof item === 'string'));
  }
}

function walkReferences(value: unknown, entities: string[], services: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkReferences(item, entities, services);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'entity_id') {
        pushEntityValue(child, entities);
      } else if (key === 'target' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        pushEntityValue((child as Record<string, unknown>).entity_id, entities);
      }
      if (key === 'service' && typeof child === 'string') services.push(child);
      walkReferences(child, entities, services);
    }
  }
}
