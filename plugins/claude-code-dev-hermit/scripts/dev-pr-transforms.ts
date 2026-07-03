#!/usr/bin/env bun
// Deterministic string transforms for /dev-pr, extracted from the skill prose
// so the skill calls a script instead of describing the algorithm. The skill
// keeps all orchestration (push, credential-helper retry, forge CLI dispatch,
// FAIL-message wording, bindings record); this script only computes.
//
// Subcommands (JSON to stdout):
//   classify-forge <pr_create_cmd>   -> {tool, forge, verdict, reason}
//   rewrite-ssh <forge> <remote_url> -> {url} | {error}
//   build-title <base_ref>           -> {title}
//   build-summary <base_ref>         -> {bullets: string[]}
//
// The exported functions are pure so tests exercise them with fixtures (no git
// needed). The CLI is a thin git/bindings collector, gated behind import.meta.main.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

type Json = any;

const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?!?:\s*/i;

// ── Pure transforms ─────────────────────────────────────────────────────────

// Classify origin host into a forge, derive the tool from the PR command, and
// judge coherence. Fails only when both sides are recognized and mismatched.
export function classifyForge(prCreateCmd: string, remoteUrl: string): {
  tool: string; forge: string; verdict: 'ok' | 'fail' | 'warn'; reason: string;
} {
  const firstWord = (prCreateCmd || '').trim().split(/\s+/)[0] || '';
  const tool = firstWord ? path.basename(firstWord) : '';

  const url = remoteUrl || '';
  const forge = /github\.com|github\./.test(url) ? 'github'
              : /gitlab\.com|gitlab\./.test(url) ? 'gitlab'
              : /bitbucket\.org/.test(url) ? 'bitbucket'
              : 'custom';

  if (forge === 'github' && tool !== 'gh') {
    return { tool, forge, verdict: 'fail', reason: 'github origin needs the gh CLI' };
  }
  if (forge === 'gitlab' && tool !== 'glab') {
    return { tool, forge, verdict: 'fail', reason: 'gitlab origin needs the glab CLI' };
  }
  if ((forge === 'github' && tool === 'gh') || (forge === 'gitlab' && tool === 'glab')) {
    return { tool, forge, verdict: 'ok', reason: 'forge and tool agree' };
  }
  return { tool, forge, verdict: 'warn', reason: 'unrecognized forge/tool pairing — proceeding' };
}

// Rewrite an SSH remote to its canonical HTTPS form. github/gitlab only; the
// scp-style OWNER/REPO tail is preserved verbatim (gitlab subgroups included).
export function rewriteSsh(forge: string, remoteUrl: string): { url: string } | { error: string } {
  const canonical: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com' };
  const host = canonical[forge];
  if (!host) return { error: `SSH→HTTPS rewrite not supported for forge '${forge}'` };
  const m = (remoteUrl || '').match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (!m) return { error: `cannot parse SSH remote: ${remoteUrl}` };
  return { url: `https://${host}/${m[1]}.git` };
}

export function stripConventionalPrefix(subject: string): string {
  return subject.replace(CONVENTIONAL_PREFIX, '');
}

// Title priority: binding id + raw first subject → stripped first subject →
// branch slug. Binding case is intentionally unstripped (mirrors the prose).
export function deriveTitle(
  commits: string[],
  branch: string,
  binding: { id?: string; title?: string } | null,
): { title: string } {
  const first = commits[0] ?? '';
  if (binding && binding.id && binding.title) {
    return { title: `${binding.id}: ${first}` };
  }
  if (first) {
    return { title: stripConventionalPrefix(first) };
  }
  return { title: branch.replace(/\//g, '-') };
}

// Strip conventional prefixes, then dedup by exact post-strip string preserving
// first-occurrence order.
export function stripAndDedup(subjects: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of subjects) {
    const stripped = stripConventionalPrefix(s);
    if (!seen.has(stripped)) { seen.add(stripped); out.push(stripped); }
  }
  return out;
}

// ── CLI collectors ──────────────────────────────────────────────────────────

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return ''; }
}

function findHermitDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-code-hermit', 'config.json'))) {
      return path.join(dir, '.claude-code-hermit');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadBinding(branch: string): { id?: string; title?: string } | null {
  const hermitDir = findHermitDir(process.cwd());
  if (!hermitDir) return null;
  try {
    const b = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'bindings.json'), 'utf-8'));
    const ext = b?.bindings?.[branch]?.external;
    if (!ext) return null;
    return { id: ext.id, title: ext.title };
  } catch (_) { return null; }
}

function subjectsInRange(base: string, reverse: boolean): string[] {
  const flag = reverse ? '--reverse ' : '';
  const out = git(`log --first-parent ${flag}${base}..HEAD --pretty=format:%s`);
  return out ? out.split('\n').filter(Boolean) : [];
}

if (import.meta.main) {
  const argv = process.argv;
  const emit = (obj: Json) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

  switch (argv[2]) {
    case 'classify-forge': {
      const prCreateCmd = argv[3] || '';
      emit(classifyForge(prCreateCmd, git('remote get-url origin')));
      break;
    }
    case 'rewrite-ssh': {
      emit(rewriteSsh(argv[3] || '', argv[4] || ''));
      break;
    }
    case 'build-title': {
      const base = argv[3] || '';
      const branch = git('rev-parse --abbrev-ref HEAD');
      // oldest-first so commits[0] is the branch's first commit (see report note).
      emit(deriveTitle(subjectsInRange(base, true), branch, loadBinding(branch)));
      break;
    }
    case 'build-summary': {
      emit({ bullets: stripAndDedup(subjectsInRange(argv[3] || '', false)) });
      break;
    }
    default:
      console.error(`unknown subcommand: ${argv[2] ?? '(none)'}`);
      process.exit(1);
  }
}
