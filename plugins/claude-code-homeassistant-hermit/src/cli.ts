// WP7 tier 3 port of src/ha_agent_lab/cli.py — the argv-compatible CLI behind
// bin/ha-agent-lab. Stdout shapes and exit codes are a contract consumed by
// skills; JSON output replicates Python json.dumps byte-for-byte where
// feasible (indent=2, ensure_ascii escaping, compact separators with spaces).
//
// Parser: hand-rolled argparse equivalent. Error messages, usage strings and
// exit code 2 match CPython argparse for the observed paths (no args, unknown
// command/subcommand, missing positional/required sub, bad --reload choice,
// bad --window-days int, unrecognized arguments). Argparse's abbreviated
// `--flag` prefix matching is NOT replicated — flags must be spelled out.
//
// Dependency injection: main(argv, deps) accepts overrides for loadConfig,
// client construction and refreshContext — the TS equivalent of the pytest
// monkeypatching of cli.load_config / cli.HomeAssistantClient /
// cli.refresh_context.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isConfigCheckOk, readConfig, removeConfig, validateAndApply } from './apply';
import {
  currentSessionId,
  slugify,
  standardMetadata,
  utcTimestamp,
  writeJsonArtifact,
  writeMarkdownArtifact,
} from './artifacts';
import { auditAutomations, auditScripts } from './audits';
import { automationDiff, formatAutomationDiff } from './automation-diff';
import { bootStatus, saveBootPreferences } from './boot';
import { AppConfig, loadConfig, normalizedContextPath, projectRoot } from './config';
import { HomeAssistantClient, HomeAssistantError, extractHaErrorMessage } from './ha-api';
import { HomeAssistantWsClient } from './ha-ws';
import { fetchHistorySnapshot } from './history';
import {
  computeDegradedDomains,
  formatIntegrationHealthStdout,
  writeDegradedDomainsArtifact,
} from './integration-health';
import { checkEntity, gateServiceCall, gateStructuralMutation, normalizeEntityIndex } from './policy';
import type { MutationGate } from './policy';
import { evaluateYamlPolicy, simulateArtifact } from './simulate';
import { computeSilenceSummary } from './silence';
import { captureStates, restoreStates, DEFAULT_DOMAINS } from './snapshot-restore';
import { collectPendingUpdates, formatUpdatesStdout } from './update-check';
import {
  HELPER_TYPES,
  type WsCommandClient,
  type WsMutationResult,
  type WsReadResult,
  createArea,
  createBackup,
  createDashboard,
  createFloor,
  createHelper,
  createLabel,
  deleteArea,
  deleteDashboard,
  deleteFloor,
  deleteHelper,
  deleteLabel,
  disableConfigEntry,
  exposeEntity,
  getDashboard,
  getEnergyPrefs,
  importBlueprint,
  listAreas,
  listBackups,
  listBlueprints,
  listDashboards,
  listDevices,
  listEntities,
  listExposedEntities,
  listFloors,
  listHelpers,
  listLabels,
  listSystemLog,
  parseJsonObject,
  saveDashboard,
  setCoreConfig,
  setEnergyPrefs,
  updateArea,
  updateDevice,
  updateEntity,
} from './structure';
import { daysAgo, isoUtc } from './time-utils';
import { parseYaml } from './yaml';

// ---------------------------------------------------------------------------
// JSON output helpers — Python json.dumps parity
// ---------------------------------------------------------------------------

/** json.dumps(ensure_ascii=True): escape every non-ASCII UTF-16 code unit. */
function escapeNonAscii(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function jsonDumps(value: unknown, options: { indent?: number; ensureAscii?: boolean } = {}): string {
  const { indent = 2, ensureAscii = true } = options;
  const text = JSON.stringify(value, null, indent);
  return ensureAscii ? escapeNonAscii(text) : text;
}

/** Python json.dumps default separators (', ', ': ') — single-line. */
function jsonDumpsCompact(value: unknown): string {
  if (value === null || typeof value !== 'object') return escapeNonAscii(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(jsonDumpsCompact).join(', ')}]`;
  const entries = Object.entries(value).map(
    ([key, child]) => `${escapeNonAscii(JSON.stringify(key))}: ${jsonDumpsCompact(child)}`,
  );
  return `{${entries.join(', ')}}`;
}

/** date.today().isoformat() — local date. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Dependency injection (pytest monkeypatch equivalent)
// ---------------------------------------------------------------------------

/** The client surface the CLI uses (HomeAssistantClient satisfies it). */
export interface CliClient {
  baseUrlSource: string;
  get(path: string): Promise<any>;
  post(path: string, payload?: Record<string, unknown> | null): Promise<any>;
  delete(path: string): Promise<any>;
  postText(path: string, payload?: Record<string, unknown> | null): Promise<string>;
  getText(path: string): Promise<string>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<any>;
  getStates(): Promise<Array<Record<string, any>>>;
  getHistory(
    entityIds: string[],
    startTime: Date,
    endTime: Date,
  ): Promise<Record<string, Array<Record<string, any>>>>;
}

export interface CliDeps {
  loadConfig: (root?: string | null) => AppConfig;
  createClient: (config: AppConfig) => Promise<CliClient>;
  createWsClient: (config: AppConfig) => Promise<WsCommandClient>;
  refreshContext: (root: string, client: CliClient) => Promise<Record<string, any>>;
}

function resolveDeps(overrides: Partial<CliDeps>): CliDeps {
  return {
    loadConfig: overrides.loadConfig ?? loadConfig,
    createClient: overrides.createClient ?? ((config) => HomeAssistantClient.create(config)),
    createWsClient: overrides.createWsClient ?? ((config) => HomeAssistantWsClient.create(config)),
    refreshContext: overrides.refreshContext ?? refreshContext,
  };
}

// ---------------------------------------------------------------------------
// Argparse-equivalent parsing
// ---------------------------------------------------------------------------

class ParserExit extends Error {
  constructor(readonly code: number) {
    super(`parser exit ${code}`);
  }
}

const TOP_USAGE = 'usage: ha_agent_lab [-h] {boot,ha} ...';
const BOOT_USAGE = 'usage: ha_agent_lab boot [-h] {status,store} ...';
const HA_COMMANDS = [
  'refresh-context',
  'simulate',
  'validate-apply',
  'policy-check',
  'audit-automations',
  'audit-scripts',
  'probe',
  'integration-health',
  'updates',
  'fetch-history',
  'list-automations',
  'list-scripts',
  'list-scenes',
  'delete-automation',
  'delete-script',
  'delete-scene',
  'get-automation-config',
  'get-script-config',
  'get-scene-config',
  'automation-diff',
  'snapshot-states',
  'restore-states',
  'list-helpers',
  'create-helper',
  'delete-helper',
  'list-areas',
  'create-area',
  'delete-area',
  'list-entities',
  'rename-entity',
  'set-entity-area',
  'set-entity-enabled',
  'set-entity-icon',
  'set-entity-hidden',
  'set-entity-labels',
  'set-entity-categories',
  'set-entity-aliases',
  'list-devices',
  'set-device-area',
  'rename-device',
  'list-dashboards',
  'get-dashboard',
  'apply-dashboard',
  'create-dashboard',
  'delete-dashboard',
  'render-template',
  'check-config',
  'call-service',
  'set-core-config',
  'error-log',
  'logbook',
  'system-log',
  'list-floors',
  'create-floor',
  'delete-floor',
  'list-labels',
  'create-label',
  'delete-label',
  'rename-area',
  'set-area-icon',
  'set-area-floor',
  'set-area-labels',
  'list-exposed-entities',
  'expose-entity',
  'list-backups',
  'create-backup',
  'list-blueprints',
  'import-blueprint',
  'get-energy-prefs',
  'set-energy-prefs',
  'reload-entry',
  'disable-entry',
  'trigger-automation',
] as const;
const HA_USAGE = [
  'usage: ha_agent_lab ha [-h]',
  `                       {${HA_COMMANDS.join(',')}}`,
  '                       ...',
].join('\n');

const TOP_HELP = `${TOP_USAGE}

positional arguments:
  {boot,ha}

options:
  -h, --help  show this help message and exit`;

const BOOT_HELP = `${BOOT_USAGE}

positional arguments:
  {status,store}

options:
  -h, --help      show this help message and exit`;

const HA_HELP = `${HA_USAGE}

positional arguments:
  {${HA_COMMANDS.join(',')}}
    audit-automations   Audit all live HA automations against the safety
                        policy.
    audit-scripts       Audit all live HA scripts against the safety policy.
    probe               GET a raw HA REST path and print the JSON response.
                        Useful for verifying endpoints.
    integration-health  Detect degraded HA integrations and write
                        state/integration-health-degraded-domains.json.
    updates             List pending Home Assistant updates (update.* domain)
                        with version deltas, tiered core/os/supervisor/addon/
                        hacs.
    fetch-history       Fetch and aggregate HA history into a snapshot
                        artifact. Requires a normalized snapshot; runs
                        \`refresh-context\` first if none exists.
    list-automations    List all automation entity IDs and config IDs.
    list-scripts        List all script entity IDs and config IDs.
    list-scenes         List all scene entity IDs and config IDs.
    delete-automation   Delete an automation config by ID.
    delete-script       Delete a script config by ID.
    delete-scene        Delete a scene config by ID.
    get-automation-config
                        Read an automation's stored config from HA.
    get-script-config   Read a script's stored config from HA.
    get-scene-config    Read a scene's stored config from HA.
    automation-diff     Report automations added/removed/edited/disabled since
                        the last snapshot (change memory across sessions).
    snapshot-states     Capture entity states to a named artifact for later
                        restore.
    restore-states      Restore captured entity states via scene.apply
                        (gated by ha_safety_mode).
    list-helpers        List helpers (input_*, timer, counter, schedule) via
                        WebSocket. Optional --type to scope to one.
    create-helper       Create a helper from JSON via WebSocket (gated write).
    delete-helper       Delete a helper by id via WebSocket (gated write).
    list-areas          List areas via WebSocket.
    create-area         Create an area by name via WebSocket (gated write).
    delete-area         Delete an area by id via WebSocket (gated write).
    list-entities       List the entity registry via WebSocket (--registry).
    rename-entity       Set an entity's friendly name (gated write).
    set-entity-area     Assign an entity to an area (gated write).
    set-entity-enabled  Enable/disable an entity (gated write).
    set-entity-icon     Set an entity's icon (gated write).
    set-entity-hidden   Hide/show an entity in the UI (gated write).
    set-entity-labels   Set an entity's labels (gated write).
    set-entity-categories
                        Set an entity's per-scope categories from JSON
                        (gated write).
    set-entity-aliases  Set an entity's Assist aliases (gated write).
    list-devices        List the device registry via WebSocket.
    set-device-area     Assign a device to an area (gated write).
    rename-device       Set a device's user name (gated write).
    list-dashboards     List Lovelace dashboards via WebSocket.
    get-dashboard       Read a dashboard's config via WebSocket (--url-path;
                        default dashboard if omitted).
    apply-dashboard     Save/replace a dashboard's config from an artifact
                        via WebSocket (gated write).
    create-dashboard    Create a dashboard from JSON via WebSocket (gated
                        write).
    delete-dashboard    Delete a dashboard by id via WebSocket (gated write).
    render-template     Render a Jinja2 template against live state
                        (POST /api/template). Not gated (read-only against
                        HA's template engine).
    check-config        Validate the HA configuration
                        (POST /api/config/core/check_config). Not gated.
    call-service        Call any HA service (POST /api/services/...).
                        Sensitive domains/entities gated by ha_safety_mode;
                        non-sensitive calls proceed in both modes.
    set-core-config     Partial update of location/unit system/currency/
                        timezone/country via WebSocket (gated write).
    error-log           Print the current-session HA error log
                        (GET /api/error_log, plaintext).
    logbook             Fetch the HA logbook (GET /api/logbook/<ts>).
    system-log          List structured system log entries, with levels,
                        via WebSocket (system_log/list).
    list-floors         List floors via WebSocket.
    create-floor        Create a floor by name via WebSocket (gated write).
    delete-floor        Delete a floor by id via WebSocket (gated write).
    list-labels         List labels via WebSocket.
    create-label        Create a label by name via WebSocket (gated write).
    delete-label        Delete a label by id via WebSocket (gated write).
    rename-area         Set an area's friendly name (gated write).
    set-area-icon       Set an area's icon (gated write).
    set-area-floor      Assign an area to a floor (gated write).
    set-area-labels     Set an area's labels (gated write).
    list-exposed-entities
                        List entities exposed to each Assist assistant via
                        WebSocket.
    expose-entity       Expose/unexpose entities to one or more Assist
                        assistants (gated write). Sets HA's expose-to-
                        Assist boundary; config, not control (see
                        SAFETY.md's Assist Control section).
    list-backups        List backups via WebSocket (backup/info).
    create-backup       Generate a backup via WebSocket (backup/generate,
                        gated write).
    list-blueprints     List blueprints for a domain via WebSocket
                        (blueprint/list).
    import-blueprint    Import a blueprint from a URL and save it under a
                        domain via WebSocket (gated write).
    get-energy-prefs    Read energy dashboard preferences via WebSocket
                        (energy/get_prefs).
    set-energy-prefs    Replace energy dashboard preferences from JSON via
                        WebSocket (energy/save_prefs, gated write).
    reload-entry        Reload a config entry (REST, gated write).
    disable-entry       Enable/disable a config entry via WebSocket
                        (config_entries/disable, gated write).
    trigger-automation  Fire an automation by entity_id via automation.trigger.

options:
  -h, --help            show this help message and exit`;

function argError(prog: string, usage: string, message: string): never {
  console.error(`${usage}\n${prog}: error: ${message}`);
  throw new ParserExit(2);
}

function printHelp(text: string): never {
  console.log(text);
  throw new ParserExit(0);
}

interface FlagSpec {
  // 'store_true' | 'value' | 'plus' (nargs='+')
  kind: 'store_true' | 'value' | 'plus';
  choices?: readonly string[];
  int?: boolean;
}

interface LeafSpec {
  prog: string;
  usage: string;
  positionals: string[];
  flags: Record<string, FlagSpec>;
}

interface ParsedLeaf {
  positionals: string[];
  flags: Record<string, unknown>;
  extras: string[];
}

function parseLeaf(spec: LeafSpec, args: string[]): ParsedLeaf {
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  const extras: string[] = [];

  for (let i = 0; i < args.length; i++) {
    let token = args[i]!;
    if (token === '-h' || token === '--help') {
      printHelp(`${spec.usage}\n\noptions:\n  -h, --help  show this help message and exit`);
    }
    let inlineValue: string | null = null;
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    if (token.startsWith('--')) {
      const flag = spec.flags[token];
      if (!flag) {
        extras.push(args[i]!);
        continue;
      }
      if (flag.kind === 'store_true') {
        if (inlineValue !== null) {
          argError(spec.prog, spec.usage, `argument ${token}: ignored explicit argument '${inlineValue}'`);
        }
        flags[token] = true;
        continue;
      }
      if (flag.kind === 'plus') {
        const values: string[] = [];
        if (inlineValue !== null) values.push(inlineValue);
        while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
          values.push(args[++i]!);
        }
        if (values.length === 0) {
          argError(spec.prog, spec.usage, `argument ${token}: expected at least one argument`);
        }
        flags[token] = values;
        continue;
      }
      let value: string;
      if (inlineValue !== null) {
        value = inlineValue;
      } else if (i + 1 < args.length) {
        value = args[++i]!;
      } else {
        argError(spec.prog, spec.usage, `argument ${token}: expected one argument`);
      }
      if (flag.choices && !flag.choices.includes(value)) {
        const choices = flag.choices.map((c) => `'${c}'`).join(', ');
        argError(spec.prog, spec.usage, `argument ${token}: invalid choice: '${value}' (choose from ${choices})`);
      }
      if (flag.int) {
        if (!/^[+-]?\d+$/.test(value.trim())) {
          argError(spec.prog, spec.usage, `argument ${token}: invalid int value: '${value}'`);
        }
        flags[token] = parseInt(value.trim(), 10);
      } else {
        flags[token] = value;
      }
      continue;
    }
    if (positionals.length < spec.positionals.length) positionals.push(token);
    else extras.push(token);
  }

  if (positionals.length < spec.positionals.length) {
    const missing = spec.positionals.slice(positionals.length).join(', ');
    argError(spec.prog, spec.usage, `the following arguments are required: ${missing}`);
  }
  return { positionals, flags, extras };
}

function rejectExtras(extras: string[]): void {
  if (extras.length > 0) {
    argError('ha_agent_lab', TOP_USAGE, `unrecognized arguments: ${extras.join(' ')}`);
  }
}

const LEAF_SPECS: Record<string, LeafSpec> = {
  'boot status': {
    prog: 'ha_agent_lab boot status',
    usage: 'usage: ha_agent_lab boot status [-h] [--probe]',
    positionals: [],
    flags: { '--probe': { kind: 'store_true' } },
  },
  'boot store': {
    prog: 'ha_agent_lab boot store',
    usage:
      'usage: ha_agent_lab boot store [-h] [--language LANGUAGE] [--url URL]\n' +
      '                               [--local-url LOCAL_URL]\n' +
      '                               [--remote-url REMOTE_URL] [--token TOKEN]',
    positionals: [],
    flags: {
      '--language': { kind: 'value' },
      '--url': { kind: 'value' },
      '--local-url': { kind: 'value' },
      '--remote-url': { kind: 'value' },
      '--token': { kind: 'value' },
    },
  },
  'ha refresh-context': {
    prog: 'ha_agent_lab ha refresh-context',
    usage: 'usage: ha_agent_lab ha refresh-context [-h] [--incremental]',
    positionals: [],
    flags: { '--incremental': { kind: 'store_true' } },
  },
  'ha simulate': {
    prog: 'ha_agent_lab ha simulate',
    usage: 'usage: ha_agent_lab ha simulate [-h] artifact',
    positionals: ['artifact'],
    flags: {},
  },
  'ha validate-apply': {
    prog: 'ha_agent_lab ha validate-apply',
    usage:
      'usage: ha_agent_lab ha validate-apply [-h] [--reload {automation,script,scene}]\n' +
      '                                      artifact',
    positionals: ['artifact'],
    flags: { '--reload': { kind: 'value', choices: ['automation', 'script', 'scene'] } },
  },
  'ha policy-check': {
    prog: 'ha_agent_lab ha policy-check',
    usage: 'usage: ha_agent_lab ha policy-check [-h] target',
    positionals: ['target'],
    flags: {},
  },
  'ha audit-automations': {
    prog: 'ha_agent_lab ha audit-automations',
    usage: 'usage: ha_agent_lab ha audit-automations [-h]',
    positionals: [],
    flags: {},
  },
  'ha audit-scripts': {
    prog: 'ha_agent_lab ha audit-scripts',
    usage: 'usage: ha_agent_lab ha audit-scripts [-h]',
    positionals: [],
    flags: {},
  },
  'ha probe': {
    prog: 'ha_agent_lab ha probe',
    usage: 'usage: ha_agent_lab ha probe [-h] path',
    positionals: ['path'],
    flags: {},
  },
  'ha integration-health': {
    prog: 'ha_agent_lab ha integration-health',
    usage: 'usage: ha_agent_lab ha integration-health [-h]',
    positionals: [],
    flags: {},
  },
  'ha updates': {
    prog: 'ha_agent_lab ha updates',
    usage: 'usage: ha_agent_lab ha updates [-h]',
    positionals: [],
    flags: {},
  },
  'ha fetch-history': {
    prog: 'ha_agent_lab ha fetch-history',
    usage:
      'usage: ha_agent_lab ha fetch-history [-h] [--window-days WINDOW_DAYS]\n' +
      '                                     [--entities ENTITY [ENTITY ...]]\n' +
      '                                     [--include-transitions]',
    positionals: [],
    flags: {
      '--window-days': { kind: 'value', int: true },
      '--entities': { kind: 'plus' },
      '--include-transitions': { kind: 'store_true' },
    },
  },
  'ha list-automations': {
    prog: 'ha_agent_lab ha list-automations',
    usage: 'usage: ha_agent_lab ha list-automations [-h]',
    positionals: [],
    flags: {},
  },
  'ha list-scripts': {
    prog: 'ha_agent_lab ha list-scripts',
    usage: 'usage: ha_agent_lab ha list-scripts [-h]',
    positionals: [],
    flags: {},
  },
  'ha list-scenes': {
    prog: 'ha_agent_lab ha list-scenes',
    usage: 'usage: ha_agent_lab ha list-scenes [-h]',
    positionals: [],
    flags: {},
  },
  'ha delete-automation': {
    prog: 'ha_agent_lab ha delete-automation',
    usage: 'usage: ha_agent_lab ha delete-automation [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha delete-script': {
    prog: 'ha_agent_lab ha delete-script',
    usage: 'usage: ha_agent_lab ha delete-script [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha delete-scene': {
    prog: 'ha_agent_lab ha delete-scene',
    usage: 'usage: ha_agent_lab ha delete-scene [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha get-automation-config': {
    prog: 'ha_agent_lab ha get-automation-config',
    usage: 'usage: ha_agent_lab ha get-automation-config [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha get-scene-config': {
    prog: 'ha_agent_lab ha get-scene-config',
    usage: 'usage: ha_agent_lab ha get-scene-config [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha get-script-config': {
    prog: 'ha_agent_lab ha get-script-config',
    usage: 'usage: ha_agent_lab ha get-script-config [-h] id',
    positionals: ['id'],
    flags: {},
  },
  'ha automation-diff': {
    prog: 'ha_agent_lab ha automation-diff',
    usage: 'usage: ha_agent_lab ha automation-diff [-h]',
    positionals: [],
    flags: {},
  },
  'ha snapshot-states': {
    prog: 'ha_agent_lab ha snapshot-states',
    usage:
      'usage: ha_agent_lab ha snapshot-states [-h] [--name NAME]\n' +
      '                                       [--domains DOMAINS]\n' +
      '                                       [--entities ENTITY [ENTITY ...]]',
    positionals: [],
    flags: {
      '--name': { kind: 'value' },
      '--domains': { kind: 'value' },
      '--entities': { kind: 'plus' },
    },
  },
  'ha restore-states': {
    prog: 'ha_agent_lab ha restore-states',
    usage: 'usage: ha_agent_lab ha restore-states [-h] [--confirm] artifact',
    positionals: ['artifact'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha list-helpers': {
    prog: 'ha_agent_lab ha list-helpers',
    usage: `usage: ha_agent_lab ha list-helpers [-h] [--type {${HELPER_TYPES.join(',')}}]`,
    positionals: [],
    flags: { '--type': { kind: 'value', choices: HELPER_TYPES } },
  },
  'ha create-helper': {
    prog: 'ha_agent_lab ha create-helper',
    usage: `usage: ha_agent_lab ha create-helper [-h] [--confirm] {${HELPER_TYPES.join(',')}} json`,
    positionals: ['type', 'json'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha delete-helper': {
    prog: 'ha_agent_lab ha delete-helper',
    usage: `usage: ha_agent_lab ha delete-helper [-h] [--confirm] {${HELPER_TYPES.join(',')}} id`,
    positionals: ['type', 'id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha list-areas': {
    prog: 'ha_agent_lab ha list-areas',
    usage: 'usage: ha_agent_lab ha list-areas [-h]',
    positionals: [],
    flags: {},
  },
  'ha create-area': {
    prog: 'ha_agent_lab ha create-area',
    usage: 'usage: ha_agent_lab ha create-area [-h] [--confirm] name',
    positionals: ['name'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha delete-area': {
    prog: 'ha_agent_lab ha delete-area',
    usage: 'usage: ha_agent_lab ha delete-area [-h] [--confirm] id',
    positionals: ['id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha list-entities': {
    prog: 'ha_agent_lab ha list-entities',
    usage: 'usage: ha_agent_lab ha list-entities [-h] --registry',
    positionals: [],
    flags: { '--registry': { kind: 'store_true' } },
  },
  'ha rename-entity': {
    prog: 'ha_agent_lab ha rename-entity',
    usage: 'usage: ha_agent_lab ha rename-entity [-h] [--confirm] --name NAME entity_id',
    positionals: ['entity_id'],
    flags: { '--name': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-area': {
    prog: 'ha_agent_lab ha set-entity-area',
    usage: 'usage: ha_agent_lab ha set-entity-area [-h] [--confirm] --area AREA entity_id',
    positionals: ['entity_id'],
    flags: { '--area': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-enabled': {
    prog: 'ha_agent_lab ha set-entity-enabled',
    usage: 'usage: ha_agent_lab ha set-entity-enabled [-h] [--confirm] --enabled {true,false} entity_id',
    positionals: ['entity_id'],
    flags: { '--enabled': { kind: 'value', choices: ['true', 'false'] }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-icon': {
    prog: 'ha_agent_lab ha set-entity-icon',
    usage: 'usage: ha_agent_lab ha set-entity-icon [-h] [--confirm] --icon ICON entity_id',
    positionals: ['entity_id'],
    flags: { '--icon': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-hidden': {
    prog: 'ha_agent_lab ha set-entity-hidden',
    usage: 'usage: ha_agent_lab ha set-entity-hidden [-h] [--confirm] --hidden {true,false} entity_id',
    positionals: ['entity_id'],
    flags: { '--hidden': { kind: 'value', choices: ['true', 'false'] }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-labels': {
    prog: 'ha_agent_lab ha set-entity-labels',
    usage: 'usage: ha_agent_lab ha set-entity-labels [-h] [--confirm] --labels LABEL [LABEL ...] entity_id',
    positionals: ['entity_id'],
    flags: { '--labels': { kind: 'plus' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-categories': {
    prog: 'ha_agent_lab ha set-entity-categories',
    usage: 'usage: ha_agent_lab ha set-entity-categories [-h] [--confirm] --categories JSON entity_id',
    positionals: ['entity_id'],
    flags: { '--categories': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-entity-aliases': {
    prog: 'ha_agent_lab ha set-entity-aliases',
    usage: 'usage: ha_agent_lab ha set-entity-aliases [-h] [--confirm] --aliases ALIAS [ALIAS ...] entity_id',
    positionals: ['entity_id'],
    flags: { '--aliases': { kind: 'plus' }, '--confirm': { kind: 'store_true' } },
  },
  'ha list-devices': {
    prog: 'ha_agent_lab ha list-devices',
    usage: 'usage: ha_agent_lab ha list-devices [-h]',
    positionals: [],
    flags: {},
  },
  'ha set-device-area': {
    prog: 'ha_agent_lab ha set-device-area',
    usage: 'usage: ha_agent_lab ha set-device-area [-h] [--confirm] --area AREA device_id',
    positionals: ['device_id'],
    flags: { '--area': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha rename-device': {
    prog: 'ha_agent_lab ha rename-device',
    usage: 'usage: ha_agent_lab ha rename-device [-h] [--confirm] --name NAME device_id',
    positionals: ['device_id'],
    flags: { '--name': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha list-dashboards': {
    prog: 'ha_agent_lab ha list-dashboards',
    usage: 'usage: ha_agent_lab ha list-dashboards [-h]',
    positionals: [],
    flags: {},
  },
  'ha get-dashboard': {
    prog: 'ha_agent_lab ha get-dashboard',
    usage: 'usage: ha_agent_lab ha get-dashboard [-h] [--url-path URL_PATH]',
    positionals: [],
    flags: { '--url-path': { kind: 'value' } },
  },
  'ha apply-dashboard': {
    prog: 'ha_agent_lab ha apply-dashboard',
    usage:
      'usage: ha_agent_lab ha apply-dashboard [-h] [--url-path URL_PATH]\n' +
      '                                       [--confirm]\n' +
      '                                       artifact',
    positionals: ['artifact'],
    flags: { '--url-path': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha create-dashboard': {
    prog: 'ha_agent_lab ha create-dashboard',
    usage: 'usage: ha_agent_lab ha create-dashboard [-h] [--confirm] json',
    positionals: ['json'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha delete-dashboard': {
    prog: 'ha_agent_lab ha delete-dashboard',
    usage: 'usage: ha_agent_lab ha delete-dashboard [-h] [--confirm] dashboard_id',
    positionals: ['dashboard_id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha render-template': {
    prog: 'ha_agent_lab ha render-template',
    usage: 'usage: ha_agent_lab ha render-template [-h] template',
    positionals: ['template'],
    flags: {},
  },
  'ha check-config': {
    prog: 'ha_agent_lab ha check-config',
    usage: 'usage: ha_agent_lab ha check-config [-h]',
    positionals: [],
    flags: {},
  },
  'ha call-service': {
    prog: 'ha_agent_lab ha call-service',
    usage: 'usage: ha_agent_lab ha call-service [-h] [--data DATA] [--confirm] domain.service',
    positionals: ['domain.service'],
    flags: { '--data': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-core-config': {
    prog: 'ha_agent_lab ha set-core-config',
    usage:
      'usage: ha_agent_lab ha set-core-config [-h] [--latitude LATITUDE]\n' +
      '                                       [--longitude LONGITUDE]\n' +
      '                                       [--elevation ELEVATION]\n' +
      '                                       [--unit-system {metric,us_customary}]\n' +
      '                                       [--currency CURRENCY]\n' +
      '                                       [--time-zone TIME_ZONE] [--country COUNTRY]\n' +
      '                                       [--confirm]',
    positionals: [],
    flags: {
      '--latitude': { kind: 'value' },
      '--longitude': { kind: 'value' },
      '--elevation': { kind: 'value', int: true },
      '--unit-system': { kind: 'value', choices: ['metric', 'us_customary'] },
      '--currency': { kind: 'value' },
      '--time-zone': { kind: 'value' },
      '--country': { kind: 'value' },
      '--confirm': { kind: 'store_true' },
    },
  },
  'ha error-log': {
    prog: 'ha_agent_lab ha error-log',
    usage: 'usage: ha_agent_lab ha error-log [-h]',
    positionals: [],
    flags: {},
  },
  'ha logbook': {
    prog: 'ha_agent_lab ha logbook',
    usage:
      'usage: ha_agent_lab ha logbook [-h] [--window-days WINDOW_DAYS]\n' +
      '                               [--entity ENTITY]',
    positionals: [],
    flags: { '--window-days': { kind: 'value', int: true }, '--entity': { kind: 'value' } },
  },
  'ha system-log': {
    prog: 'ha_agent_lab ha system-log',
    usage: 'usage: ha_agent_lab ha system-log [-h]',
    positionals: [],
    flags: {},
  },
  'ha list-floors': {
    prog: 'ha_agent_lab ha list-floors',
    usage: 'usage: ha_agent_lab ha list-floors [-h]',
    positionals: [],
    flags: {},
  },
  'ha create-floor': {
    prog: 'ha_agent_lab ha create-floor',
    usage: 'usage: ha_agent_lab ha create-floor [-h] [--confirm] name',
    positionals: ['name'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha delete-floor': {
    prog: 'ha_agent_lab ha delete-floor',
    usage: 'usage: ha_agent_lab ha delete-floor [-h] [--confirm] id',
    positionals: ['id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha list-labels': {
    prog: 'ha_agent_lab ha list-labels',
    usage: 'usage: ha_agent_lab ha list-labels [-h]',
    positionals: [],
    flags: {},
  },
  'ha create-label': {
    prog: 'ha_agent_lab ha create-label',
    usage: 'usage: ha_agent_lab ha create-label [-h] [--confirm] name',
    positionals: ['name'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha delete-label': {
    prog: 'ha_agent_lab ha delete-label',
    usage: 'usage: ha_agent_lab ha delete-label [-h] [--confirm] id',
    positionals: ['id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha rename-area': {
    prog: 'ha_agent_lab ha rename-area',
    usage: 'usage: ha_agent_lab ha rename-area [-h] [--confirm] --name NAME area_id',
    positionals: ['area_id'],
    flags: { '--name': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-area-icon': {
    prog: 'ha_agent_lab ha set-area-icon',
    usage: 'usage: ha_agent_lab ha set-area-icon [-h] [--confirm] --icon ICON area_id',
    positionals: ['area_id'],
    flags: { '--icon': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-area-floor': {
    prog: 'ha_agent_lab ha set-area-floor',
    usage: 'usage: ha_agent_lab ha set-area-floor [-h] [--confirm] --floor FLOOR area_id',
    positionals: ['area_id'],
    flags: { '--floor': { kind: 'value' }, '--confirm': { kind: 'store_true' } },
  },
  'ha set-area-labels': {
    prog: 'ha_agent_lab ha set-area-labels',
    usage: 'usage: ha_agent_lab ha set-area-labels [-h] [--confirm] --labels LABEL [LABEL ...] area_id',
    positionals: ['area_id'],
    flags: { '--labels': { kind: 'plus' }, '--confirm': { kind: 'store_true' } },
  },
  'ha list-exposed-entities': {
    prog: 'ha_agent_lab ha list-exposed-entities',
    usage: 'usage: ha_agent_lab ha list-exposed-entities [-h]',
    positionals: [],
    flags: {},
  },
  'ha expose-entity': {
    prog: 'ha_agent_lab ha expose-entity',
    usage:
      'usage: ha_agent_lab ha expose-entity [-h] --entity-ids ENTITY [ENTITY ...]\n' +
      '                                     --assistants ASSISTANT [ASSISTANT ...]\n' +
      '                                     --expose {true,false} [--confirm]',
    positionals: [],
    flags: {
      '--entity-ids': { kind: 'plus' },
      '--assistants': { kind: 'plus' },
      '--expose': { kind: 'value', choices: ['true', 'false'] },
      '--confirm': { kind: 'store_true' },
    },
  },
  'ha list-backups': {
    prog: 'ha_agent_lab ha list-backups',
    usage: 'usage: ha_agent_lab ha list-backups [-h]',
    positionals: [],
    flags: {},
  },
  'ha create-backup': {
    prog: 'ha_agent_lab ha create-backup',
    usage:
      'usage: ha_agent_lab ha create-backup [-h] --agent-ids AGENT [AGENT ...]\n' +
      '                                     [--name NAME] [--password PASSWORD]\n' +
      '                                     [--include-addons SLUG [SLUG ...]]\n' +
      '                                     [--include-all-addons]\n' +
      '                                     [--include-database {true,false}]\n' +
      '                                     [--include-folders FOLDER [FOLDER ...]]\n' +
      '                                     [--include-homeassistant {true,false}]\n' +
      '                                     [--confirm]',
    positionals: [],
    flags: {
      '--agent-ids': { kind: 'plus' },
      '--name': { kind: 'value' },
      '--password': { kind: 'value' },
      '--include-addons': { kind: 'plus' },
      '--include-all-addons': { kind: 'store_true' },
      '--include-database': { kind: 'value', choices: ['true', 'false'] },
      '--include-folders': { kind: 'plus' },
      '--include-homeassistant': { kind: 'value', choices: ['true', 'false'] },
      '--confirm': { kind: 'store_true' },
    },
  },
  'ha list-blueprints': {
    prog: 'ha_agent_lab ha list-blueprints',
    usage: 'usage: ha_agent_lab ha list-blueprints [-h] domain',
    positionals: ['domain'],
    flags: {},
  },
  'ha import-blueprint': {
    prog: 'ha_agent_lab ha import-blueprint',
    usage: 'usage: ha_agent_lab ha import-blueprint [-h] [--confirm] domain url',
    positionals: ['domain', 'url'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha get-energy-prefs': {
    prog: 'ha_agent_lab ha get-energy-prefs',
    usage: 'usage: ha_agent_lab ha get-energy-prefs [-h]',
    positionals: [],
    flags: {},
  },
  'ha set-energy-prefs': {
    prog: 'ha_agent_lab ha set-energy-prefs',
    usage: 'usage: ha_agent_lab ha set-energy-prefs [-h] [--confirm] json',
    positionals: ['json'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha reload-entry': {
    prog: 'ha_agent_lab ha reload-entry',
    usage: 'usage: ha_agent_lab ha reload-entry [-h] [--confirm] entry_id',
    positionals: ['entry_id'],
    flags: { '--confirm': { kind: 'store_true' } },
  },
  'ha disable-entry': {
    prog: 'ha_agent_lab ha disable-entry',
    usage: 'usage: ha_agent_lab ha disable-entry [-h] [--confirm] --disabled {true,false} entry_id',
    positionals: ['entry_id'],
    flags: { '--disabled': { kind: 'value', choices: ['true', 'false'] }, '--confirm': { kind: 'store_true' } },
  },
  'ha trigger-automation': {
    prog: 'ha_agent_lab ha trigger-automation',
    usage: 'usage: ha_agent_lab ha trigger-automation [-h] automation_id',
    positionals: ['automation_id'],
    flags: {},
  },
};

interface ParsedArgs {
  command: 'boot' | 'ha';
  sub: string;
  positionals: string[];
  flags: Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === '-h' || argv[0] === '--help') printHelp(TOP_HELP);
  if (argv.length === 0) {
    argError('ha_agent_lab', TOP_USAGE, 'the following arguments are required: command');
  }
  const command = argv[0]!;
  if (command !== 'boot' && command !== 'ha') {
    argError(
      'ha_agent_lab',
      TOP_USAGE,
      `argument command: invalid choice: '${command}' (choose from 'boot', 'ha')`,
    );
  }

  const rest = argv.slice(1);
  if (rest[0] === '-h' || rest[0] === '--help') {
    printHelp(command === 'boot' ? BOOT_HELP : HA_HELP);
  }
  const subProg = `ha_agent_lab ${command}`;
  const subUsage = command === 'boot' ? BOOT_USAGE : HA_USAGE;
  const subDest = command === 'boot' ? 'boot_command' : 'ha_command';
  if (rest.length === 0) {
    argError(subProg, subUsage, `the following arguments are required: ${subDest}`);
  }
  const sub = rest[0]!;
  const validSubs = command === 'boot' ? ['status', 'store'] : [...HA_COMMANDS];
  if (!validSubs.includes(sub)) {
    const choices = validSubs.map((c) => `'${c}'`).join(', ');
    argError(subProg, subUsage, `argument ${subDest}: invalid choice: '${sub}' (choose from ${choices})`);
  }

  const spec = LEAF_SPECS[`${command} ${sub}`]!;
  const leaf = parseLeaf(spec, rest.slice(1));
  rejectExtras(leaf.extras);
  return { command: command as 'boot' | 'ha', sub, positionals: leaf.positionals, flags: leaf.flags };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = resolveDeps(overrides);

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    if (exc instanceof ParserExit) return exc.code;
    throw exc;
  }

  const config = deps.loadConfig(projectRoot());
  const root = config.root;

  if (args.command === 'ha' && args.sub === 'policy-check') {
    return handlePolicyCheck(args.positionals[0]!, root);
  }

  if (args.command === 'boot' && args.sub === 'status') {
    const status = await bootStatus(config, { probe: Boolean(args.flags['--probe']) });
    console.log(jsonDumps(status));
    return 0;
  }

  if (args.command === 'boot' && args.sub === 'store') {
    const changes = saveBootPreferences(root, {
      language: (args.flags['--language'] as string | undefined) ?? null,
      url: (args.flags['--url'] as string | undefined) ?? null,
      localUrl: (args.flags['--local-url'] as string | undefined) ?? null,
      remoteUrl: (args.flags['--remote-url'] as string | undefined) ?? null,
      token: (args.flags['--token'] as string | undefined) ?? null,
    });
    console.log(jsonDumps({ updated: changes }));
    return 0;
  }

  if (args.command === 'ha' && args.sub === 'integration-health') {
    return handleIntegrationHealth(root, config, deps);
  }

  if (args.command === 'ha' && args.sub === 'updates') {
    return handleUpdates(config, deps);
  }

  if (args.command === 'ha' && args.sub === 'refresh-context') {
    try {
      const client = await deps.createClient(config);
      if (args.flags['--incremental']) {
        const [payload, delta] = await refreshContextIncremental(root, client, deps);
        console.log(
          jsonDumps({
            status: 'ok',
            mode: 'incremental',
            entities: Object.keys(payload.entity_index).length,
            added: delta.added.length,
            removed: delta.removed.length,
            changed: delta.changed.length,
            base_url_source: client.baseUrlSource,
          }),
        );
      } else {
        const payload = await deps.refreshContext(root, client);
        console.log(
          jsonDumps({
            status: 'ok',
            mode: 'full',
            entities: Object.keys(payload.entity_index).length,
            base_url_source: client.baseUrlSource,
          }),
        );
      }
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'fetch-history') {
    return handleFetchHistory(
      root,
      config,
      deps,
      (args.flags['--window-days'] as number | undefined) ?? 7,
      (args.flags['--entities'] as string[] | undefined) ?? null,
      Boolean(args.flags['--include-transitions']),
    );
  }

  if (args.command === 'ha' && args.sub === 'simulate') {
    const result = simulateArtifact(root, resolve(args.positionals[0]!));
    console.log(
      jsonDumps({
        valid: result.isValid,
        missing_entities: result.missingEntities,
        blocked_reasons: result.blockedReasons,
      }),
    );
    return result.isValid ? 0 : 1;
  }

  if (args.command === 'ha' && (args.sub === 'audit-automations' || args.sub === 'audit-scripts')) {
    try {
      const client = await deps.createClient(config);
      const domain = args.sub === 'audit-automations' ? 'automation' : 'script';
      const summary =
        domain === 'automation'
          ? await auditAutomations(root, client)
          : await auditScripts(root, client);
      printSafetyAuditSummary(summary, domain);
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'probe') {
    try {
      const client = await deps.createClient(config);
      const response = await client.get(args.positionals[0]!);
      console.log(jsonDumps(response, { ensureAscii: false }));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.error(`HA error ${exc.statusCode}: ${String(exc.payload).slice(0, 500)}`);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'validate-apply') {
    try {
      const client = await deps.createClient(config);
      const result = await validateAndApply(
        root,
        client,
        resolve(args.positionals[0]!),
        (args.flags['--reload'] as string | undefined) ?? null,
      );
      console.log(
        jsonDumps({
          ok: result.ok,
          config_id: result.configId,
          creation_attempted: result.creationAttempted,
          creation_ok: result.creationOk,
          reload_attempted: result.reloadAttempted,
          message: result.message,
          report_path: relative(root, result.reportPath),
          base_url_source: client.baseUrlSource,
        }),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && (args.sub === 'list-automations' || args.sub === 'list-scripts')) {
    try {
      const client = await deps.createClient(config);
      const domain = args.sub === 'list-automations' ? 'automation' : 'script';
      const items = await listDomain(client, domain);
      console.log(jsonDumps(items, { ensureAscii: false }));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'list-scenes') {
    try {
      const client = await deps.createClient(config);
      const items = await listDomain(client, 'scene');
      console.log(jsonDumps(items, { ensureAscii: false }));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && (args.sub === 'delete-automation' || args.sub === 'delete-script')) {
    try {
      const client = await deps.createClient(config);
      const domain = args.sub === 'delete-automation' ? 'automation' : 'script';
      const result = await removeConfig(root, client, domain, args.positionals[0]!);
      console.log(
        jsonDumps({
          ok: result.ok,
          domain: result.domain,
          config_id: result.configId,
          message: result.message,
          report_path: relative(root, result.reportPath),
        }),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'delete-scene') {
    try {
      const client = await deps.createClient(config);
      const result = await removeConfig(root, client, 'scene', args.positionals[0]!);
      console.log(
        jsonDumps({
          ok: result.ok,
          domain: result.domain,
          config_id: result.configId,
          message: result.message,
          report_path: relative(root, result.reportPath),
        }),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (
    args.command === 'ha' &&
    (args.sub === 'get-automation-config' || args.sub === 'get-script-config')
  ) {
    try {
      const client = await deps.createClient(config);
      const domain = args.sub === 'get-automation-config' ? 'automation' : 'script';
      const result = await readConfig(client, domain, args.positionals[0]!);
      console.log(
        jsonDumps(
          {
            ok: result.ok,
            domain: result.domain,
            config_id: result.configId,
            config: result.config,
            message: result.message,
          },
          { ensureAscii: false },
        ),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'get-scene-config') {
    try {
      const client = await deps.createClient(config);
      const result = await readConfig(client, 'scene', args.positionals[0]!);
      console.log(
        jsonDumps(
          {
            ok: result.ok,
            domain: result.domain,
            config_id: result.configId,
            config: result.config,
            message: result.message,
          },
          { ensureAscii: false },
        ),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'automation-diff') {
    try {
      const client = await deps.createClient(config);
      const result = await automationDiff(root, client);
      console.log(formatAutomationDiff(result));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'snapshot-states') {
    try {
      const client = await deps.createClient(config);
      const domainsFlag = args.flags['--domains'] as string | undefined;
      const entities = args.flags['--entities'] as string[] | undefined;
      const result = await captureStates(root, client, {
        name: (args.flags['--name'] as string | undefined) ?? 'snapshot',
        domains: domainsFlag
          ? domainsFlag.split(',').map((d) => d.trim()).filter(Boolean)
          : DEFAULT_DOMAINS,
        entities,
      });
      console.log(
        jsonDumps(
          {
            ok: result.ok,
            name: result.name,
            captured: result.captured,
            entities: result.entities,
            report_path: relative(root, result.reportPath),
            message: result.message,
          },
          { ensureAscii: false },
        ),
      );
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'restore-states') {
    try {
      const client = await deps.createClient(config);
      const result = await restoreStates(root, client, {
        artifactPath: resolve(args.positionals[0]!),
        confirm: Boolean(args.flags['--confirm']),
      });
      const payload: Record<string, unknown> = {
        ok: result.ok,
        blocked: result.blocked,
        needs_confirm: result.needsConfirm,
        applied: result.applied,
        entities: result.entities,
        sensitive: result.sensitive,
        reason: result.reason,
        message: result.message,
      };
      if (result.suggestion) payload.suggestion = result.suggestion;
      if (result.reportPath) payload.report_path = relative(root, result.reportPath);
      console.log(jsonDumps(payload, { ensureAscii: false }));
      return result.ok ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  // --- WebSocket structural commands (helpers, areas, registries) ---

  if (args.command === 'ha' && args.sub === 'list-helpers') {
    return runWsRead(deps, config, (ws) => listHelpers(ws, args.flags['--type'] as string | undefined));
  }
  if (args.command === 'ha' && args.sub === 'create-helper') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createHelper(root, ws, args.positionals[0]!, args.positionals[1]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'delete-helper') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      deleteHelper(root, ws, args.positionals[0]!, args.positionals[1]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'list-areas') {
    return runWsRead(deps, config, listAreas);
  }
  if (args.command === 'ha' && args.sub === 'create-area') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createArea(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'delete-area') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      deleteArea(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'list-entities') {
    if (!args.flags['--registry']) {
      console.log(jsonDumps({ ok: false, message: 'Only registry mode is supported; pass --registry.' }));
      return 1;
    }
    return runWsRead(deps, config, listEntities);
  }
  if (args.command === 'ha' && args.sub === 'rename-entity') {
    const name = requireFlag(args.flags['--name'], '--name');
    if (name === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { name }, 'rename-entity'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-area') {
    const area = requireFlag(args.flags['--area'], '--area');
    if (area === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { area_id: area }, 'set-entity-area'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-enabled') {
    const enabled = requireFlag(args.flags['--enabled'], '--enabled');
    if (enabled === null) return 1;
    const disabledBy = enabled === 'true' ? null : 'user';
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { disabled_by: disabledBy }, 'set-entity-enabled'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-icon') {
    const icon = requireFlag(args.flags['--icon'], '--icon');
    if (icon === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { icon }, 'set-entity-icon'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-hidden') {
    const hidden = requireFlag(args.flags['--hidden'], '--hidden');
    if (hidden === null) return 1;
    const hiddenBy = hidden === 'true' ? 'user' : null;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { hidden_by: hiddenBy }, 'set-entity-hidden'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-labels') {
    const labels = requirePlusFlag(args.flags['--labels'], '--labels');
    if (labels === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { labels }, 'set-entity-labels'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-categories') {
    const raw = requireFlag(args.flags['--categories'], '--categories');
    if (raw === null) return 1;
    const parsed = parseJsonObject(raw);
    if (!parsed.ok) {
      console.log(jsonDumps({ ok: false, message: `--categories ${parsed.message}` }));
      return 1;
    }
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { categories: parsed.payload }, 'set-entity-categories'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-entity-aliases') {
    const aliases = requirePlusFlag(args.flags['--aliases'], '--aliases');
    if (aliases === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateEntity(root, ws, args.positionals[0]!, { aliases }, 'set-entity-aliases'),
    );
  }
  if (args.command === 'ha' && args.sub === 'list-devices') {
    return runWsRead(deps, config, listDevices);
  }
  if (args.command === 'ha' && args.sub === 'set-device-area') {
    const area = requireFlag(args.flags['--area'], '--area');
    if (area === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateDevice(root, ws, args.positionals[0]!, { area_id: area }, 'set-device-area'),
    );
  }
  if (args.command === 'ha' && args.sub === 'rename-device') {
    const name = requireFlag(args.flags['--name'], '--name');
    if (name === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateDevice(root, ws, args.positionals[0]!, { name_by_user: name }, 'rename-device'),
    );
  }
  if (args.command === 'ha' && args.sub === 'list-dashboards') {
    return runWsRead(deps, config, listDashboards);
  }
  if (args.command === 'ha' && args.sub === 'get-dashboard') {
    const urlPath = (args.flags['--url-path'] as string | undefined) ?? null;
    return runWsRead(deps, config, (ws) => getDashboard(ws, urlPath));
  }
  if (args.command === 'ha' && args.sub === 'apply-dashboard') {
    const urlPath = (args.flags['--url-path'] as string | undefined) ?? null;
    const artifactPath = resolve(args.positionals[0]!);
    // Read+parse before opening the WS: a missing/malformed artifact must
    // surface a clean {ok:false} (not an uncaught throw past runWsMutation's
    // HomeAssistantError-only catch), and without wasting a WS connection.
    if (!existsSync(artifactPath)) {
      console.log(jsonDumps({ ok: false, message: `Dashboard artifact not found: ${args.positionals[0]}` }));
      return 1;
    }
    let dashboardConfig: unknown;
    try {
      dashboardConfig = parseYaml(readFileSync(artifactPath, 'utf8'));
    } catch (exc) {
      console.log(
        jsonDumps({ ok: false, message: `Failed to parse dashboard artifact: ${exc instanceof Error ? exc.message : String(exc)}` }),
      );
      return 1;
    }
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      saveDashboard(root, ws, urlPath, dashboardConfig),
    );
  }
  if (args.command === 'ha' && args.sub === 'create-dashboard') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createDashboard(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'delete-dashboard') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      deleteDashboard(root, ws, args.positionals[0]!),
    );
  }

  if (args.command === 'ha' && args.sub === 'render-template') {
    const source = args.positionals[0]!;
    if (source !== '-' && !existsSync(resolve(source))) {
      console.log(jsonDumps({ ok: false, message: `Template file not found: ${source}` }));
      return 1;
    }
    try {
      const client = await deps.createClient(config);
      const template = source === '-' ? await Bun.stdin.text() : readFileSync(resolve(source), 'utf8');
      const rendered = await client.postText('/api/template', { template });
      console.log(rendered);
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'check-config') {
    try {
      const client = await deps.createClient(config);
      const result = await client.post('/api/config/core/check_config');
      console.log(jsonDumps(result, { ensureAscii: false }));
      return isConfigCheckOk(result) ? 0 : 1;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'call-service') {
    return handleCallService(
      args.positionals[0]!,
      args.flags['--data'] as string | undefined,
      Boolean(args.flags['--confirm']),
      root,
      config,
      deps,
    );
  }

  if (args.command === 'ha' && args.sub === 'set-core-config') {
    const fields: Record<string, unknown> = {};
    // Reject a non-numeric latitude/longitude up front: Number('40,7') is NaN,
    // which JSON.stringify serializes as null, silently blanking the stored
    // coordinate instead of erroring.
    for (const [flag, key] of [
      ['--latitude', 'latitude'],
      ['--longitude', 'longitude'],
    ] as const) {
      const raw = args.flags[flag];
      if (raw === undefined) continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        console.log(jsonDumps({ ok: false, message: `${flag} must be a number, got: '${raw}'` }));
        return 1;
      }
      fields[key] = num;
    }
    const setIfPresent = (flag: string, key: string) => {
      const value = args.flags[flag];
      if (value !== undefined) fields[key] = value;
    };
    setIfPresent('--elevation', 'elevation');
    setIfPresent('--unit-system', 'unit_system');
    setIfPresent('--currency', 'currency');
    setIfPresent('--time-zone', 'time_zone');
    setIfPresent('--country', 'country');

    if (Object.keys(fields).length === 0) {
      console.log(jsonDumps({ ok: false, message: 'At least one config field flag is required.' }));
      return 1;
    }
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      setCoreConfig(root, ws, fields),
    );
  }

  if (args.command === 'ha' && args.sub === 'error-log') {
    try {
      const client = await deps.createClient(config);
      console.log(await client.getText('/api/error_log'));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'logbook') {
    try {
      const client = await deps.createClient(config);
      const windowDays = (args.flags['--window-days'] as number | undefined) ?? 1;
      const windowStart = daysAgo(windowDays);
      const entity = args.flags['--entity'] as string | undefined;
      const path = `/api/logbook/${encodeURIComponent(isoUtc(windowStart))}${entity ? `?entity=${encodeURIComponent(entity)}` : ''}`;
      const result = await client.get(path);
      console.log(jsonDumps(result, { ensureAscii: false }));
      return 0;
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.log(exc.message);
      return 1;
    }
  }

  if (args.command === 'ha' && args.sub === 'system-log') {
    return runWsRead(deps, config, listSystemLog);
  }

  if (args.command === 'ha' && args.sub === 'list-floors') {
    return runWsRead(deps, config, listFloors);
  }
  if (args.command === 'ha' && args.sub === 'create-floor') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createFloor(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'delete-floor') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      deleteFloor(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'list-labels') {
    return runWsRead(deps, config, listLabels);
  }
  if (args.command === 'ha' && args.sub === 'create-label') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createLabel(root, ws, args.positionals[0]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'delete-label') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      deleteLabel(root, ws, args.positionals[0]!),
    );
  }

  if (args.command === 'ha' && args.sub === 'rename-area') {
    const name = requireFlag(args.flags['--name'], '--name');
    if (name === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateArea(root, ws, args.positionals[0]!, { name }, 'rename-area'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-area-icon') {
    const icon = requireFlag(args.flags['--icon'], '--icon');
    if (icon === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateArea(root, ws, args.positionals[0]!, { icon }, 'set-area-icon'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-area-floor') {
    const floor = requireFlag(args.flags['--floor'], '--floor');
    if (floor === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateArea(root, ws, args.positionals[0]!, { floor_id: floor }, 'set-area-floor'),
    );
  }
  if (args.command === 'ha' && args.sub === 'set-area-labels') {
    const labels = requirePlusFlag(args.flags['--labels'], '--labels');
    if (labels === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      updateArea(root, ws, args.positionals[0]!, { labels }, 'set-area-labels'),
    );
  }

  if (args.command === 'ha' && args.sub === 'list-exposed-entities') {
    return runWsRead(deps, config, listExposedEntities);
  }
  if (args.command === 'ha' && args.sub === 'expose-entity') {
    const entityIds = requirePlusFlag(args.flags['--entity-ids'], '--entity-ids');
    if (entityIds === null) return 1;
    const assistants = requirePlusFlag(args.flags['--assistants'], '--assistants');
    if (assistants === null) return 1;
    const expose = requireFlag(args.flags['--expose'], '--expose');
    if (expose === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      exposeEntity(root, ws, entityIds, assistants, expose === 'true'),
    );
  }

  if (args.command === 'ha' && args.sub === 'list-backups') {
    return runWsRead(deps, config, listBackups);
  }
  if (args.command === 'ha' && args.sub === 'create-backup') {
    const agentIds = requirePlusFlag(args.flags['--agent-ids'], '--agent-ids');
    if (agentIds === null) return 1;
    const fields: Record<string, unknown> = { agent_ids: agentIds };
    const setIfPresent = (flag: string, key: string, transform: (v: unknown) => unknown = (v) => v) => {
      const value = args.flags[flag];
      if (value !== undefined) fields[key] = transform(value);
    };
    setIfPresent('--name', 'name');
    setIfPresent('--password', 'password');
    setIfPresent('--include-addons', 'include_addons');
    setIfPresent('--include-all-addons', 'include_all_addons');
    setIfPresent('--include-database', 'include_database', (v) => v === 'true');
    setIfPresent('--include-folders', 'include_folders');
    setIfPresent('--include-homeassistant', 'include_homeassistant', (v) => v === 'true');

    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      createBackup(root, ws, fields),
    );
  }

  if (args.command === 'ha' && args.sub === 'list-blueprints') {
    return runWsRead(deps, config, (ws) => listBlueprints(ws, args.positionals[0]!));
  }
  if (args.command === 'ha' && args.sub === 'import-blueprint') {
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      importBlueprint(root, ws, args.positionals[0]!, args.positionals[1]!),
    );
  }
  if (args.command === 'ha' && args.sub === 'get-energy-prefs') {
    return runWsRead(deps, config, getEnergyPrefs);
  }
  if (args.command === 'ha' && args.sub === 'set-energy-prefs') {
    const parsed = parseJsonObject(args.positionals[0]!);
    if (!parsed.ok) {
      console.log(jsonDumps({ ok: false, message: `energy prefs JSON ${parsed.message}` }));
      return 1;
    }
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      setEnergyPrefs(root, ws, parsed.payload),
    );
  }
  if (args.command === 'ha' && args.sub === 'reload-entry') {
    return handleReloadEntry(args.positionals[0]!, Boolean(args.flags['--confirm']), root, config, deps);
  }
  if (args.command === 'ha' && args.sub === 'disable-entry') {
    const disabled = requireFlag(args.flags['--disabled'], '--disabled');
    if (disabled === null) return 1;
    return runWsMutation(deps, config, root, Boolean(args.flags['--confirm']), (ws) =>
      disableConfigEntry(root, ws, args.positionals[0]!, disabled === 'true'),
    );
  }

  if (args.command === 'ha' && args.sub === 'trigger-automation') {
    return handleTriggerAutomation(args.positionals[0]!, config, deps);
  }

  // Unreachable: every subcommand is handled above (argparse parity guard).
  console.error(`${TOP_USAGE}\nha_agent_lab: error: Unsupported command.`);
  return 2;
}

/** A value flag the handler needs but argparse treats as optional. Prints and returns null when absent. */
function requireFlag(value: unknown, name: string): string | null {
  if (typeof value === 'string') return value;
  console.log(jsonDumps({ ok: false, message: `${name} is required.` }));
  return null;
}

/** A plus (nargs='+') flag the handler needs but argparse treats as optional. Prints and returns null when absent. */
function requirePlusFlag(value: unknown, name: string): string[] | null {
  if (Array.isArray(value)) return value as string[];
  console.log(jsonDumps({ ok: false, message: `${name} is required.` }));
  return null;
}

/** Acquire a WS client, run a read, print {ok,data,message}, then close. */
async function runWsRead(
  deps: CliDeps,
  config: AppConfig,
  run: (ws: WsCommandClient) => Promise<WsReadResult>,
): Promise<number> {
  let ws: WsCommandClient;
  try {
    ws = await deps.createWsClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(exc.message);
    return 1;
  }
  try {
    const result = await run(ws);
    console.log(jsonDumps({ ok: result.ok, data: result.data, message: result.message }, { ensureAscii: false }));
    return result.ok ? 0 : 1;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(exc.message);
    return 1;
  } finally {
    ws.close();
  }
}

/**
 * Apply the safety gate *before* opening a connection. If blocked, print the
 * verdict and return without touching the network. Otherwise connect, run the
 * mutation, print, and close.
 */
async function runWsMutation(
  deps: CliDeps,
  config: AppConfig,
  root: string,
  confirmed: boolean,
  run: (ws: WsCommandClient) => Promise<WsMutationResult>,
): Promise<number> {
  const gate = gateStructuralMutation(root, confirmed);
  if (!gate.allowed) {
    console.log(
      jsonDumps({
        ok: false,
        blocked: true,
        requires_confirm: gate.requiresConfirm,
        mode: gate.mode,
        data: null,
        message: gate.reason,
        report_path: null,
      }),
    );
    return 1;
  }

  let ws: WsCommandClient;
  try {
    ws = await deps.createWsClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(exc.message);
    return 1;
  }
  try {
    const r = await run(ws);
    console.log(
      jsonDumps(
        {
          ok: r.ok,
          blocked: false,
          requires_confirm: false,
          mode: gate.mode,
          data: r.data,
          message: r.message,
          report_path: r.reportPath ? relative(root, r.reportPath) : null,
        },
        { ensureAscii: false },
      ),
    );
    return r.ok ? 0 : 1;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(exc.message);
    return 1;
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleFetchHistory(
  root: string,
  config: AppConfig,
  deps: CliDeps,
  windowDays: number,
  entityOverride: string[] | null,
  includeTransitions: boolean,
): Promise<number> {
  let client: CliClient;
  try {
    client = await deps.createClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.error(exc.message);
    return 1;
  }

  const snapshotPath = normalizedContextPath(root);
  if (!existsSync(snapshotPath)) {
    try {
      await deps.refreshContext(root, client);
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      console.error(exc.message);
      return 1;
    }
  }

  let payload: Record<string, any>;
  try {
    const normalized = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    payload = await fetchHistorySnapshot(root, client, normalized, {
      windowDays,
      entityOverride,
      includeTransitions,
    });
  } catch (exc: any) {
    // Python catches (HomeAssistantError, OSError, json.JSONDecodeError).
    console.error(String(exc?.message ?? exc));
    return 1;
  }

  console.log(
    jsonDumpsCompact({
      status: 'ok',
      entities: payload.requested_entities.length,
      events: payload.event_total,
      window_days: windowDays,
    }),
  );
  return 0;
}

export async function handleIntegrationHealth(
  root: string,
  config: AppConfig,
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps = resolveDeps(overrides);
  const today = todayIso();
  const header = `ha-integration-health findings — ${today}`;
  const snapshotPath = normalizedContextPath(root);

  let stale = false;
  try {
    const mtimeMs = statSync(snapshotPath).mtimeMs;
    stale = Date.now() - mtimeMs > 24 * 3600 * 1000;
  } catch {
    stale = true;
  }

  if (stale) {
    try {
      const client = await deps.createClient(config);
      await deps.refreshContext(root, client);
    } catch (exc: any) {
      console.log(
        `${header}\nNo actionable findings. (skipped: snapshot stale, refresh failed — ${exc?.message ?? exc})`,
      );
      return 0;
    }
  }

  let normalized: Record<string, any>;
  try {
    normalized = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch (exc: any) {
    console.log(`${header}\nNo actionable findings. (skipped: snapshot unreadable — ${exc?.message ?? exc})`);
    return 0;
  }

  const payload = computeDegradedDomains(normalized);
  writeDegradedDomainsArtifact(root, payload);
  console.log(formatIntegrationHealthStdout(payload, today));
  return 0;
}

export async function handleUpdates(config: AppConfig, overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = resolveDeps(overrides);
  const today = todayIso();
  const header = `ha-update-check findings — ${today}`;
  let states: Array<Record<string, any>>;
  try {
    const client = await deps.createClient(config);
    states = await client.getStates();
  } catch (exc: any) {
    console.log(`${header}\nNo actionable findings. (skipped: ${exc?.message ?? exc})`);
    return 0;
  }
  const updates = collectPendingUpdates(states);
  console.log(formatUpdatesStdout(updates, today));
  return 0;
}

async function listDomain(client: CliClient, domain: string): Promise<Array<Record<string, any>>> {
  const states = await client.get('/api/states');
  const prefix = `${domain}.`;
  const items: Array<Record<string, any>> = [];
  for (const s of states) {
    if (!(s !== null && typeof s === 'object' && String(s.entity_id ?? '').startsWith(prefix))) {
      continue;
    }
    const attrs = s.attributes || {};
    const configId = attrs.id;
    items.push({
      entity_id: s.entity_id,
      id: configId ?? null,
      friendly_name: attrs.friendly_name ?? null,
      state: s.state ?? null,
      last_changed: s.last_changed ?? null,
      deletable: configId !== null && configId !== undefined,
    });
  }
  items.sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  return items;
}

function printSafetyAuditSummary(summary: Record<string, any>, domain = 'automation'): void {
  const violations: Array<Record<string, any>> = summary.violations ?? [];
  const acknowledged: Array<Record<string, any>> = summary.acknowledged ?? [];
  const total: number = summary[`total_${domain}s`] ?? 0;
  const unmanaged: string[] = summary.unmanaged ?? [];
  const fetchFailures: string[] = summary.fetch_failures ?? [];
  const label = domain === 'automation' ? 'ha-safety-audit' : `ha-${domain}-safety-audit`;
  console.log(`${label} findings — ${todayIso()}`);
  if (violations.length === 0) {
    console.log(`No actionable findings. (${total} ${domain}s scanned)`);
  } else {
    console.log(`Policy violations: ${violations.length}`);
    for (const v of violations) {
      const reasons = (v.reasons ?? []).join('; ');
      console.log(`- ${v.alias} (\`${v.id}\`): ${reasons}`);
    }
    console.log(`No action needed: ${summary.passed} ${domain}s passed`);
  }
  if (acknowledged.length > 0) console.log(`Acknowledged (suppressed): ${acknowledged.length}`);
  if (unmanaged.length > 0) console.log(`Skipped (no numeric id): ${unmanaged.length}`);
  if (fetchFailures.length > 0) console.log(`Skipped (404 on config fetch): ${fetchFailures.length}`);
}

interface GatedRestReportSpec {
  type: string;
  title: string;
  idKey: string;
}
const CALL_SERVICE_REPORT: GatedRestReportSpec = {
  type: 'call-service',
  title: 'Call-Service Report',
  idKey: 'domain_service',
};
const RELOAD_ENTRY_REPORT: GatedRestReportSpec = {
  type: 'reload-entry',
  title: 'Reload-Entry Report',
  idKey: 'entry_id',
};

/** Every gated REST write that actually reaches HA writes an audit report — matches restoreStates. */
function writeGatedRestReport(root: string, spec: GatedRestReportSpec, id: string, data: unknown): string {
  const tag = `ha-${spec.type}`;
  const prefix = `audit-${tag}`;
  const metadata = standardMetadata(spec.type, `${spec.title} — ${id}`, {
    session: currentSessionId(root),
    tags: [tag],
    extra: { [spec.idKey]: id, data },
  });
  const body = [`# ${spec.title} for \`${id}\``, '', `- data: ${JSON.stringify(data)}`].join('\n');
  return writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    `${prefix}-${slugify(id)}`,
    metadata,
    body,
    `${prefix}-latest.md`,
  );
}

/**
 * Shared driver for the two REST-based gated writes (call-service, reload-entry):
 * emit the blocked JSON if the gate refuses, otherwise run the call, write an
 * audit report, and emit the standard {ok,blocked,requires_confirm,mode,data,
 * message,report_path} envelope — mirrors runWsMutation for the WS path.
 */
async function runGatedRestWrite(
  deps: CliDeps,
  config: AppConfig,
  root: string,
  gate: MutationGate,
  doCall: (client: CliClient) => Promise<unknown>,
  writeReport: (result: unknown) => string,
): Promise<number> {
  if (!gate.allowed) {
    console.log(
      jsonDumps({
        ok: false,
        blocked: true,
        requires_confirm: gate.requiresConfirm,
        mode: gate.mode,
        data: null,
        message: gate.reason,
        report_path: null,
      }),
    );
    return 1;
  }
  try {
    const client = await deps.createClient(config);
    const result = await doCall(client);
    const reportPath = writeReport(result);
    console.log(
      jsonDumps(
        {
          ok: true,
          blocked: false,
          requires_confirm: false,
          mode: gate.mode,
          data: result,
          message: 'ok',
          report_path: relative(root, reportPath),
        },
        { ensureAscii: false },
      ),
    );
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(
      jsonDumps({
        ok: false,
        blocked: false,
        requires_confirm: false,
        mode: gate.mode,
        data: null,
        message: extractHaErrorMessage(exc),
        report_path: null,
      }),
    );
    return 1;
  }
}

async function handleCallService(
  target: string,
  rawData: string | undefined,
  confirmed: boolean,
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  const dot = target.indexOf('.');
  if (dot === -1) {
    console.log(jsonDumps({ ok: false, message: `domain.service must contain a '.', got: '${target}'` }));
    return 2;
  }
  const domain = target.slice(0, dot);
  const service = target.slice(dot + 1);

  let data: Record<string, unknown> = {};
  if (rawData !== undefined) {
    const parsedData = parseJsonObject(rawData);
    if (!parsedData.ok) {
      console.log(jsonDumps({ ok: false, message: `--data ${parsedData.message}` }));
      return 1;
    }
    data = parsedData.payload;
  }

  const gate = gateServiceCall(root, domain, service, data, confirmed);
  return runGatedRestWrite(
    deps,
    config,
    root,
    gate,
    (client) => client.callService(domain, service, data),
    () => writeGatedRestReport(root, CALL_SERVICE_REPORT, target, data),
  );
}

async function handleReloadEntry(
  entryId: string,
  confirmed: boolean,
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  const gate = gateStructuralMutation(root, confirmed);
  return runGatedRestWrite(
    deps,
    config,
    root,
    gate,
    (client) => client.post(`/api/config/config_entries/entry/${entryId}/reload`),
    (result) => writeGatedRestReport(root, RELOAD_ENTRY_REPORT, entryId, result),
  );
}

async function handleTriggerAutomation(
  automationId: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  if (!automationId.startsWith('automation.')) {
    console.log(
      jsonDumps(
        { status: 'error', message: `automation_id must start with 'automation.', got: '${automationId}'` },
        { ensureAscii: false },
      ),
    );
    return 2;
  }
  try {
    const client = await deps.createClient(config);
    await client.callService('automation', 'trigger', { entity_id: automationId });
    console.log(jsonDumps({ status: 'ok', automation_id: automationId }, { ensureAscii: false }));
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    console.log(
      jsonDumps(
        { status: 'error', message: extractHaErrorMessage(exc) },
        { ensureAscii: false },
      ),
    );
    return 1;
  }
}

function handlePolicyCheck(target: string, root: string): number {
  if (existsSync(target) && (target.endsWith('.yaml') || target.endsWith('.yml'))) {
    const [entities, services, decision] = evaluateYamlPolicy(target, root);
    console.log(
      jsonDumps({
        file: target,
        blocked: decision.blocked,
        severity: decision.severity,
        entities,
        services,
        reasons: decision.reasons,
      }),
    );
    return decision.blocked ? 1 : 0;
  }
  const result = checkEntity(target);
  console.log(jsonDumps(result));
  return result.sensitive ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Context refresh
// ---------------------------------------------------------------------------

export async function refreshContext(root: string, client: CliClient): Promise<Record<string, any>> {
  const paths = ['/api/', '/api/config', '/api/components', '/api/services', '/api/states'];
  const [apiRoot, config, components, services, states] = await Promise.all(
    paths.map((path) => client.get(path)),
  );

  const snapshot = {
    api: apiRoot,
    config,
    components,
    services,
    states,
  };
  writeJsonArtifact(root, '.claude-code-hermit/raw', 'snapshot-ha-context', snapshot, 'snapshot-ha-context-latest.json');

  const normalized = normalizeContext(states, services, components);
  normalized.silence_summary = computeSilenceSummary(normalized, root);
  writeJsonArtifact(root, '.claude-code-hermit/raw', 'snapshot-ha-normalized', normalized, 'snapshot-ha-normalized-latest.json');
  writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    'audit-ha-context-refresh',
    standardMetadata('audit', 'HA Context Refresh', {
      session: currentSessionId(root),
      tags: ['ha-context', 'refresh'],
      extra: {
        source: 'routine',
        entity_count: Object.keys(normalized.entity_index).length,
        service_domain_count: Object.keys(normalized.service_index).length,
      },
    }),
    [
      '# Home Assistant Context Refresh',
      '',
      `- entities: ${Object.keys(normalized.entity_index).length}`,
      `- service_domains: ${Object.keys(normalized.service_index).length}`,
      `- components: ${normalized.components.length}`,
    ].join('\n'),
    'audit-ha-context-refresh-latest.md',
  );
  return normalized;
}

/**
 * Fetch only /api/states, diff against the existing artifact, and merge the delta.
 *
 * Returns [updatedNormalized, deltaSummary].
 * Falls back to a full refresh if no baseline artifact exists.
 */
export async function refreshContextIncremental(
  root: string,
  client: CliClient,
  overrides: Partial<CliDeps> = {},
): Promise<[Record<string, any>, Record<string, any>]> {
  const deps = resolveDeps(overrides);
  const baselinePath = normalizedContextPath(root);
  if (!existsSync(baselinePath)) {
    const payload = await deps.refreshContext(root, client);
    return [payload, { added: [], removed: [], changed: [] }];
  }

  const baseline: Record<string, any> = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baselineIndex: Record<string, any> = baseline.entity_index ?? {};

  const states: Array<Record<string, any>> = await client.get('/api/states');
  const newIndex = normalizeEntityIndex(states);

  const baselineIds = new Set(Object.keys(baselineIndex));
  const newIds = new Set(Object.keys(newIndex));

  const added = [...newIds].filter((eid) => !baselineIds.has(eid)).sort();
  const removed = [...baselineIds].filter((eid) => !newIds.has(eid)).sort();
  const changed = [...baselineIds]
    .filter(
      (eid) =>
        newIds.has(eid) &&
        (newIndex[eid]!.state !== baselineIndex[eid].state ||
          newIndex[eid]!.last_updated !== baselineIndex[eid].last_updated),
    )
    .sort();

  const mergedIndex: Record<string, any> = { ...baselineIndex };
  for (const eid of [...added, ...changed]) mergedIndex[eid] = newIndex[eid];
  for (const eid of removed) delete mergedIndex[eid];

  const unavailableEntities = collectUnavailable(mergedIndex);

  const normalized: Record<string, any> = {
    ...baseline,
    entity_index: mergedIndex,
    unavailable_entities: unavailableEntities,
    silence_summary: computeSilenceSummary(
      { entity_index: mergedIndex, unavailable_entities: unavailableEntities },
      root,
    ),
  };

  writeJsonArtifact(root, '.claude-code-hermit/raw', 'snapshot-ha-normalized', normalized, 'snapshot-ha-normalized-latest.json');

  const delta: Record<string, any> = {
    mode: 'incremental',
    timestamp: utcTimestamp(),
    added,
    removed,
    changed,
    unavailable_total: unavailableEntities.length,
    entity_total: Object.keys(mergedIndex).length,
  };
  writeJsonArtifact(root, '.claude-code-hermit/raw', 'snapshot-ha-delta', delta);

  writeMarkdownArtifact(
    root,
    '.claude-code-hermit/raw',
    'audit-ha-context-refresh',
    standardMetadata('audit', 'HA Context Refresh (incremental)', {
      session: currentSessionId(root),
      tags: ['ha-context', 'refresh', 'incremental'],
      extra: {
        source: 'routine',
        mode: 'incremental',
        entity_count: Object.keys(mergedIndex).length,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        unavailable: unavailableEntities.length,
      },
    }),
    [
      '# Home Assistant Context Refresh (incremental)',
      '',
      `- entities: ${Object.keys(mergedIndex).length}`,
      `- added: ${added.length}`,
      `- removed: ${removed.length}`,
      `- changed: ${changed.length}`,
      `- unavailable: ${unavailableEntities.length}`,
    ].join('\n'),
    'audit-ha-context-refresh-latest.md',
  );

  return [normalized, delta];
}

function collectUnavailable(entityIndex: Record<string, any>): string[] {
  return Object.entries(entityIndex)
    .filter(([, state]) => ['unavailable', 'unknown'].includes(String(state.state)))
    .map(([eid]) => eid)
    .sort();
}

export function normalizeContext(
  states: Array<Record<string, any>>,
  services: Array<Record<string, any>>,
  components: unknown[],
): Record<string, any> {
  const entityIndex = normalizeEntityIndex(states);
  const serviceIndex: Record<string, string[]> = {};
  for (const item of services) {
    const domain = item.domain;
    if (typeof domain !== 'string') continue;
    const servicesPayload = item.services ?? {};
    const serviceNames = new Set<string>();
    if (Array.isArray(servicesPayload)) {
      for (const service of servicesPayload) {
        if (service !== null && typeof service === 'object') {
          const name = service.service;
          if (typeof name === 'string') serviceNames.add(name);
        }
      }
    } else if (servicesPayload !== null && typeof servicesPayload === 'object') {
      for (const name of Object.keys(servicesPayload)) serviceNames.add(name);
    }
    serviceIndex[domain] = [...serviceNames].sort();
  }
  return {
    entity_index: entityIndex,
    service_index: serviceIndex,
    components: components.filter((c): c is string => typeof c === 'string').sort(),
    unavailable_entities: collectUnavailable(entityIndex),
  };
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
