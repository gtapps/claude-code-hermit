#!/usr/bin/env python3
"""Graceful shutdown for hermit autonomous sessions.

Sends /session-close --shutdown to the running Claude instance before
killing the tmux session, ensuring a clean session report is generated.

Usage:
    python scripts/hermit-stop.py              # graceful shutdown
    python scripts/hermit-stop.py --force      # immediate kill
"""

import json
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path('.claude-code-hermit/config.json')
SESSIONS_DIR = Path('.claude-code-hermit/sessions')
SHELL_PATH = SESSIONS_DIR / 'SHELL.md'
DEFAULT_TIMEOUT = 60  # seconds to wait for graceful close


def load_config():
    """Load config.json for session name."""
    if not CONFIG_PATH.exists():
        print('[hermit] No config found. Is this a hermit project?')
        sys.exit(1)

    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_session_name(config):
    """Resolve tmux session name from config."""
    name = config.get('tmux_session_name', 'hermit-{project_name}')
    project_name = Path.cwd().name
    return name.replace('{project_name}', project_name)


def session_exists(name):
    """Check if tmux session exists."""
    result = subprocess.run(
        ['tmux', 'has-session', '-t', name],
        capture_output=True,
    )
    return result.returncode == 0


def find_latest_report():
    """Find the most recent session report."""
    reports = sorted(SESSIONS_DIR.glob('S-*-REPORT.md'))
    return reports[-1] if reports else None


def read_active_session():
    """Read SHELL.md for session stats."""
    if not SHELL_PATH.exists():
        return None
    content = SHELL_PATH.read_text()
    stats = {}
    for line in content.split('\n'):
        if '**Status:**' in line:
            stats['status'] = line.split('**Status:**')[1].strip()
        elif '**Tasks Completed:**' in line:
            stats['tasks_completed'] = line.split('**Tasks Completed:**')[1].strip()
        elif '**Started:**' in line:
            stats['started'] = line.split('**Started:**')[1].strip()
    return stats


def save_config(config):
    """Write config back to disk."""
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)
            f.write('\n')
    except OSError:
        pass


def main():
    force = '--force' in sys.argv

    config = load_config()
    session_name = get_session_name(config)

    if not session_exists(session_name):
        print(f'[hermit] No running session: {session_name}')
        config['always_on'] = False
        save_config(config)
        report = find_latest_report()
        if report:
            print(f'[hermit] Last report: {report}')
        sys.exit(0)

    # Show session stats
    stats = read_active_session()
    tasks = '0'
    if stats:
        tasks = stats.get('tasks_completed', '0')
        started = stats.get('started', 'unknown')
        status = stats.get('status', 'unknown')
        print(f'[hermit] Session started: {started} | Status: {status} | Tasks: {tasks}')

    if force:
        print(f'[hermit] Force-killing session: {session_name}')
        config['always_on'] = False
        save_config(config)
        subprocess.run(['tmux', 'kill-session', '-t', session_name])
        report = find_latest_report()
        if report:
            print(f'[hermit] Last report: {report}')
        print('[hermit] Warning: session was not closed gracefully. SHELL.md may be stale.')
        return

    # Stop heartbeat first (only if enabled in config)
    if config.get('heartbeat', {}).get('enabled', False):
        print('[hermit] Stopping heartbeat...')
        subprocess.run([
            'tmux', 'send-keys', '-t', session_name,
            '/claude-code-hermit:heartbeat stop', 'Enter',
        ])
        time.sleep(2)

    # Graceful shutdown: send /session-close --shutdown for full close
    print(f'[hermit] Sending /claude-code-hermit:hermit-session-close --shutdown to {session_name}...')
    subprocess.run([
        'tmux', 'send-keys', '-t', session_name,
        '/claude-code-hermit:hermit-session-close --shutdown', 'Enter',
    ])

    # Wait for the session to close (check for new report file)
    reports_before = set(SESSIONS_DIR.glob('S-*-REPORT.md'))
    print(f'[hermit] Waiting up to {DEFAULT_TIMEOUT}s for session close...')

    new_report = None
    for i in range(DEFAULT_TIMEOUT):
        time.sleep(1)
        reports_now = set(SESSIONS_DIR.glob('S-*-REPORT.md'))
        if reports_now - reports_before:
            new_report = (reports_now - reports_before).pop()
            print(f'[hermit] Session closed. Report: {new_report}')
            break
    else:
        print(f'[hermit] Timeout after {DEFAULT_TIMEOUT}s. Killing session.')

    # Reset always_on flag
    config['always_on'] = False
    save_config(config)

    # Write shutdown status for shell consumers
    status_file = SESSIONS_DIR.parent / '.status'
    try:
        status_file.write_text('shutdown')
    except OSError:
        pass

    # Kill tmux session
    if session_exists(session_name):
        subprocess.run(['tmux', 'kill-session', '-t', session_name])
        print(f'[hermit] tmux session "{session_name}" terminated.')

    # Show summary
    if not new_report:
        report = find_latest_report()
        if report:
            print(f'[hermit] Latest report: {report}')
    if stats:
        print(f'[hermit] Total tasks this session: {tasks}')


if __name__ == '__main__':
    main()
