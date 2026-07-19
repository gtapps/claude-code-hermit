#!/usr/bin/env bun
// CLI over the Sentry/GlitchTip API for the error hermit.
//
// Usage:
//   bun error-api.ts check
//   bun error-api.ts issues [--since <ISO>] [--query <q>] [--limit <n>] [--json]
//   bun error-api.ts issue <id> [--json]
//   bun error-api.ts latest-event <id> [--json]
//   bun error-api.ts resolve <id> --confirm
//   bun error-api.ts mute <id> --confirm
//   bun error-api.ts help
//
// Write subcommands (resolve/mute) refuse without an exact --confirm token and
// send NO request in that case — the in-CLI gate is authoritative; the
// PreToolUse write-confirm-gate.ts hook is defense-in-depth.
//
// The token is never printed. All error text is scrubbed via redact() in the
// lib before it reaches stdout/stderr.

import {
  apiRequest,
  apiUrl,
  buildIssuesUrl,
  issuePath,
  issuesPath,
  latestEventPath,
  orgPath,
  projectRoot,
  resolveConfig,
  summarizeEvent,
  summarizeIssue,
  type ErrorHermitConfig,
  type IssueSummary,
} from './error-api-lib';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function errHttp(res: { status: number; error?: string }): void {
  err(`error: HTTP ${res.status}${res.error ? ' — ' + res.error : ''}`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function loadConfigOrReport(): ErrorHermitConfig | null {
  const { config, missing } = resolveConfig(projectRoot());
  if (!config) {
    out(`missing: ${missing.join(', ')} — run /claude-code-error-hermit:hatch`);
    return null;
  }
  return config;
}

async function cmdCheck(): Promise<number> {
  const { config, missing } = resolveConfig(projectRoot());
  if (!config) {
    out(`missing: ${missing.join(', ')}`);
    return 1;
  }
  // 1) org read — validates token + org.
  const orgRes = await apiRequest<Record<string, unknown>>(
    apiUrl(config.baseUrl, orgPath(config.org)),
    config.token,
  );
  if (!orgRes.ok) {
    if (orgRes.status === 401 || orgRes.status === 403) {
      out(`invalid: token rejected (${orgRes.status})`);
    } else if (orgRes.status === 404) {
      out(`invalid: organization "${config.org}" not found (404)`);
    } else if (orgRes.status === 0) {
      out(`unreachable: ${orgRes.error ?? 'no response from ' + config.baseUrl}`);
    } else {
      out(`unreachable: HTTP ${orgRes.status}${orgRes.error ? ' — ' + orgRes.error : ''}`);
    }
    return 1;
  }
  // 2) issues probe (limit=1) — validates project slug + the query path the
  //    watch loop depends on (GlitchTip implements a subset of Sentry search).
  const probe = await apiRequest<unknown[]>(
    apiUrl(config.baseUrl, `${issuesPath(config.org, config.project)}?limit=1`),
    config.token,
  );
  if (!probe.ok) {
    if (probe.status === 404) {
      out(`invalid: project "${config.project}" not found (404)`);
    } else {
      out(`unreachable: issues endpoint HTTP ${probe.status}${probe.error ? ' — ' + probe.error : ''}`);
    }
    return 1;
  }
  out(`ok: connected to ${config.org}/${config.project}`);
  return 0;
}

function printIssues(issues: IssueSummary[], json: boolean): void {
  if (json) {
    out(JSON.stringify(issues, null, 2));
    return;
  }
  if (issues.length === 0) {
    out('(no issues)');
    return;
  }
  for (const it of issues) {
    out(`${it.shortId || it.id}\t[${it.level || '?'}]\t${it.count || '?'}×\t${it.title}`);
  }
}

async function cmdIssues(args: string[]): Promise<number> {
  const config = loadConfigOrReport();
  if (!config) return 1;
  const json = args.includes('--json');
  const url = buildIssuesUrl(config, {
    since: flagValue(args, '--since'),
    query: flagValue(args, '--query'),
    limit: flagValue(args, '--limit'),
  });
  const res = await apiRequest<Array<Record<string, unknown>>>(url, config.token);
  if (!res.ok) {
    errHttp(res);
    return 1;
  }
  const issues = (res.data ?? []).map(summarizeIssue);
  printIssues(issues, json);
  return 0;
}

async function cmdIssue(args: string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    err('error: issue <id> required');
    return 1;
  }
  const config = loadConfigOrReport();
  if (!config) return 1;
  const res = await apiRequest<Record<string, unknown>>(
    apiUrl(config.baseUrl, issuePath(id)),
    config.token,
  );
  if (!res.ok) {
    errHttp(res);
    return 1;
  }
  const summary = summarizeIssue(res.data ?? {});
  if (args.includes('--json')) {
    out(JSON.stringify(summary, null, 2));
  } else {
    out(`${summary.shortId || summary.id}  [${summary.level}]  ${summary.status}  ${summary.count}×`);
    out(summary.title);
    out(`first ${summary.firstSeen}  last ${summary.lastSeen}`);
  }
  return 0;
}

async function cmdLatestEvent(args: string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    err('error: latest-event <id> required');
    return 1;
  }
  const config = loadConfigOrReport();
  if (!config) return 1;
  const res = await apiRequest<Record<string, unknown>>(
    apiUrl(config.baseUrl, latestEventPath(id)),
    config.token,
  );
  if (!res.ok) {
    errHttp(res);
    return 1;
  }
  const summary = summarizeEvent(res.data ?? {});
  if (args.includes('--json')) {
    // Include the raw payload for the reproduce skill (stack frames etc.), but
    // the summary carries the release tag the triage skill keys on.
    out(JSON.stringify({ summary, raw: res.data }, null, 2));
  } else {
    out(`event ${summary.id}  release ${summary.release || '(none)'}`);
    out(summary.message);
    out(summary.culprit);
  }
  return 0;
}

async function cmdWrite(kind: 'resolve' | 'mute', args: string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    err(`error: ${kind} <id> --confirm required`);
    return 1;
  }
  if (!args.includes('--confirm')) {
    err(
      `refused: ${kind} mutates the tracker and requires operator approval.\n` +
        `Surface the target issue, get explicit approval, then run:\n` +
        `  bun scripts/error-api.ts ${kind} ${id} --confirm`,
    );
    return 1;
  }
  const config = loadConfigOrReport();
  if (!config) return 1;
  const status = kind === 'resolve' ? 'resolved' : 'ignored';
  const res = await apiRequest<Record<string, unknown>>(
    apiUrl(config.baseUrl, issuePath(id)),
    config.token,
    { method: 'PUT', body: { status } },
  );
  if (!res.ok) {
    errHttp(res);
    return 1;
  }
  out(`ok: issue ${id} set to ${status}`);
  return 0;
}

function cmdHelp(): number {
  out(
    [
      'error-api.ts — Sentry/GlitchTip client for the error hermit',
      '',
      '  check                                  verify credentials + connectivity',
      '  issues [--since <ISO>] [--query <q>]    list issue groups',
      '         [--limit <n>] [--json]',
      '  issue <id> [--json]                    issue-group detail',
      '  latest-event <id> [--json]             latest event (stack, release)',
      '  resolve <id> --confirm                 mark resolved (approval-gated)',
      '  mute <id> --confirm                    ignore/mute (approval-gated)',
      '  help',
    ].join('\n'),
  );
  return 0;
}

async function main(): Promise<number> {
  const [sub, ...args] = process.argv.slice(2);
  switch (sub) {
    case 'check':
      return cmdCheck();
    case 'issues':
      return cmdIssues(args);
    case 'issue':
      return cmdIssue(args);
    case 'latest-event':
      return cmdLatestEvent(args);
    case 'resolve':
      return cmdWrite('resolve', args);
    case 'mute':
      return cmdWrite('mute', args);
    case 'help':
    case '--help':
    case undefined:
      return cmdHelp();
    default:
      err(`error: unknown subcommand "${sub}" — try: bun scripts/error-api.ts help`);
      return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
