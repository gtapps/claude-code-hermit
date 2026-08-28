// hatch-report.ts — the two operator-facing summaries hatch used to compose by hand.
//
// The load-bearing tests are the "declined step" ones: the old report was written
// by the model from its own memory of the run, so it could claim a file was
// created that the operator had refused. `final` observes the filesystem, so a
// declined .gitignore append reports as absent without anyone having to remember.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { observe, renderFinal, renderConfirm } from '../scripts/hatch-report';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-hatchreport-');
afterAll(cleanup);

interface HatchedOpts {
  claudeTarget?: 'CLAUDE.md' | 'CLAUDE.local.md' | null;
  gitignore?: boolean;
  worktreeinclude?: boolean;
  settings?: 'local' | 'committed' | null;
  git?: boolean;
  config?: Record<string, unknown>;
}

/** A project as it looks after a hatch run with the given steps taken or declined. */
function hatched(o: HatchedOpts = {}): string {
  const root = freshDir();
  const hermit = path.join(root, '.claude-code-hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermit, 'bin'), { recursive: true });
  for (const b of ['hermit-start', 'hermit-stop', 'hermit-status']) {
    fs.writeFileSync(path.join(hermit, 'bin', b), '#!/bin/sh\n');
  }
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({
    agent_name: 'Atlas', language: 'en', timezone: 'UTC', escalation: 'balanced',
    permission_mode: 'auto', push_notifications: true,
    channels: {}, routines: [{ id: 'heartbeat-restart', enabled: true }],
    scheduled_checks: [], heartbeat: { enabled: false },
    _hermit_versions: { 'claude-code-hermit': '1.2.34' },
    ...(o.config ?? {}),
  }, null, 2));
  fs.writeFileSync(path.join(hermit, 'state', 'hatch-options.json'),
    JSON.stringify({ target: o.settings === 'committed' ? 'committed' : 'local' }));

  if (o.claudeTarget) {
    fs.writeFileSync(path.join(root, o.claudeTarget),
      '# Project\n\n<!-- claude-code-hermit: Session Discipline -->\nrules\n');
  }
  if (o.gitignore) fs.writeFileSync(path.join(root, '.gitignore'), '.claude-code-hermit/sessions/\n');
  if (o.worktreeinclude) fs.writeFileSync(path.join(root, '.worktreeinclude'), '# >>> claude-code-hermit\nOPERATOR.md\n');
  if (o.settings) {
    const f = o.settings === 'local' ? '.claude/settings.local.json' : '.claude/settings.json';
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, f), JSON.stringify({
      permissions: { allow: ['Edit(.claude-code-hermit/**)'] },
    }));
  }
  if (o.git) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

describe('final reports disk truth, not a remembered file list', () => {
  test('a fully-completed hatch reports every artifact present', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: true, worktreeinclude: true, settings: 'local', git: true });
    const out = renderFinal(observe(root), 'docker');
    expect(out).toContain('CLAUDE.local.md');
    expect(out).toContain('hermit entries present');
    expect(out).toContain('managed block present');
    expect(out).toContain('.claude/settings.local.json');
    expect(out).toContain('Git repo:');
  });

  test('a declined .gitignore append reports as not present, never as created', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: false, settings: 'local' });
    const out = renderFinal(observe(root), 'interactive');
    expect(out).toMatch(/\.gitignore:\s+not present/);
    expect(out).not.toContain('Created');
  });

  test('a declined .worktreeinclude reports as not present', () => {
    const root = hatched({ worktreeinclude: false, settings: 'local' });
    expect(renderFinal(observe(root), 'tmux')).toMatch(/\.worktreeinclude:\s+not present/);
  });

  test('a declined permissions merge reports no hermit permissions found', () => {
    const root = hatched({ settings: null });
    expect(renderFinal(observe(root), 'tmux')).toContain('no hermit permissions found');
  });

  test('a skipped git init reports no repo', () => {
    const root = hatched({ git: false });
    expect(renderFinal(observe(root), 'interactive')).toMatch(/Git repo:\s+not present/);
  });

  test('a "keep" on the CLAUDE block still finds the existing marker', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md' });
    expect(renderFinal(observe(root), 'tmux')).toContain('CLAUDE.md');
  });

  test('an aborted hatch (no config.json) reports failure, not success', () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.claude-code-hermit'), { recursive: true });
    const out = renderFinal(observe(root), 'docker');
    expect(out).toContain('did not complete');
    expect(out).not.toContain('Autonomous agent initialized');
  });
});

describe('final next-steps keys off deployment', () => {
  test('docker points at docker-setup', () => {
    expect(renderFinal(observe(hatched()), 'docker')).toContain('docker-setup');
  });

  test('tmux points at the boot script', () => {
    expect(renderFinal(observe(hatched()), 'tmux')).toContain('bin/hermit-start');
  });

  // Always-on on a bare host is two moves: boot the session, then register the
  // timer that brings it back. Docker gets the second one from its restart policy.
  test('tmux also prints the watchdog install, after the boot script', () => {
    const out = renderFinal(observe(hatched()), 'tmux');
    expect(out).toContain('bin/hermit-watchdog install');
    expect(out.indexOf('bin/hermit-start')).toBeLessThan(out.indexOf('bin/hermit-watchdog install'));
  });

  test('docker and interactive do not print the watchdog install', () => {
    expect(renderFinal(observe(hatched()), 'docker')).not.toContain('hermit-watchdog install');
    expect(renderFinal(observe(hatched()), 'interactive')).not.toContain('hermit-watchdog install');
  });

  test('interactive points at /session', () => {
    expect(renderFinal(observe(hatched()), 'interactive')).toContain(':session');
  });

  test('channel-setup appears only when a channel is configured', () => {
    const without = renderFinal(observe(hatched()), 'interactive');
    expect(without).not.toContain('channel-setup');
    const withChan = renderFinal(observe(hatched({ config: { channels: { discord: { enabled: true } } } })), 'interactive');
    expect(withChan).toContain('channel-setup');
  });

  test('CLI rejects a deployment outside the enum', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'kubernetes'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('docker|tmux|interactive');
  });

  test('CLI final exits 0 and prints the report', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'tmux'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Autonomous agent initialized');
  });
});

describe('confirm previews intent, before anything is written', () => {
  test('renders the operator choices and says nothing is written yet', () => {
    const out = renderConfirm({
      agent_name: 'Atlas', language: 'pt', timezone: 'Europe/Lisbon',
      deployment: 'docker', channel: 'discord', hatch_target: 'local',
    });
    expect(out).toContain('Atlas');
    expect(out).toContain('docker');
    expect(out).toContain('discord');
    expect(out).toContain('Nothing has been written yet');
  });

  test('a skipped agent name does not render as undefined', () => {
    const out = renderConfirm({ language: 'en', deployment: 'tmux' });
    expect(out).not.toContain('undefined');
    expect(out).toContain('no name');
  });

  test('CLI confirm reads the payload from stdin', async () => {
    const r = await runScript('hatch-report.ts', {
      args: ['confirm', '/tmp'],
      stdin: JSON.stringify({ agent_name: 'Scout', deployment: 'interactive' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Scout');
  });

  test('CLI confirm rejects a non-JSON payload rather than rendering nonsense', async () => {
    const r = await runScript('hatch-report.ts', { args: ['confirm', '/tmp'], stdin: 'not json' });
    expect(r.exitCode).toBe(1);
  });
});
