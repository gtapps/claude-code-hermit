#!/usr/bin/env python3
"""Graceful shutdown for hermit autonomous sessions.

Sends /session-close --shutdown to the running Claude instance before
killing the tmux session, ensuring a clean session report is generated.

Usage:
    python scripts/hermit-stop.py              # graceful shutdown
    python scripts/hermit-stop.py --force      # immediate kill
"""

import fcntl
import json
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path('.claude-code-hermit/config.json')
STATE_DIR = CONFIG_PATH.parent / 'state'
RUNTIME_JSON = STATE_DIR / 'runtime.json'
RUNTIME_TMP = STATE_DIR / '.runtime.json.tmp'
LIFECYCLE_LOCK = STATE_DIR / '.lifecycle.lock'
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


def save_config(config):
    """Write config back to disk."""
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)
            f.write('\n')
    except OSError:
        pass


def write_runtime_json(data):
    """Atomic write to state/runtime.json."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    data['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    RUNTIME_TMP.write_text(json.dumps(data, indent=2) + '\n')
    RUNTIME_TMP.rename(RUNTIME_JSON)


def read_runtime_json():
    """Read state/runtime.json, return None if missing or invalid."""
    try:
        with open(RUNTIME_JSON) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def update_runtime_field(updates):
    """Read-modify-write runtime.json with atomic write."""
    runtime = read_runtime_json() or {}
    runtime.update(updates)
    write_runtime_json(runtime)


def acquire_lifecycle_lock():
    """Acquire exclusive lifecycle lock. Returns fd or exits on contention."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_fd = open(LIFECYCLE_LOCK, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('[hermit] Another lifecycle operation in progress. Aborting.')
        sys.exit(1)
    return lock_fd


def release_lifecycle_lock(lock_fd):
    """Release the lifecycle lock."""
    if lock_fd:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()
        except OSError:
            pass


def main():
    force = '--force' in sys.argv

    config = load_config()
    lock_fd = acquire_lifecycle_lock()
    session_name = get_session_name(config)

    if not session_exists(session_name):
        runtime = read_runtime_json()
        if runtime and runtime.get('runtime_mode') == 'interactive':
            # Claude is still running in the operator's terminal — don't corrupt
            # lifecycle truth. The Stop hook (triggered when Claude exits) owns
            # the transition to idle.
            print('[hermit] Hermit is running in interactive mode.')
            print('[hermit] Terminate the Claude process in your terminal (Ctrl+C).')
            config['always_on'] = False
            save_config(config)
            release_lifecycle_lock(lock_fd)
            sys.exit(0)
        print(f'[hermit] No running session: {session_name}')
        config['always_on'] = False
        save_config(config)
        update_runtime_field({
            'session_state': 'idle',
            'shutdown_completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        })
        sys.exit(0)

    if force:
        print(f'[hermit] Force-killing session: {session_name}')
        config['always_on'] = False
        save_config(config)
        subprocess.run(['tmux', 'kill-session', '-t', session_name])
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        update_runtime_field({
            'session_state': 'idle',
            'shutdown_requested_at': now,
            'shutdown_completed_at': now,
        })
        print('[hermit] Warning: session was not closed gracefully. SHELL.md may be stale.')
        return

    # Stop heartbeat first (only if enabled in config)
    if config.get('heartbeat', {}).get('enabled', False) and session_exists(session_name):
        print('[hermit] Stopping heartbeat...')
        subprocess.run([
            'tmux', 'send-keys', '-t', session_name,
            '/claude-code-hermit:heartbeat stop', 'Enter',
        ])
        time.sleep(2)

    # Mark shutdown requested in runtime.json
    update_runtime_field({
        'shutdown_requested_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    })

    # Release the lifecycle lock before delegating to /done.
    # The done path inside Claude needs to acquire this lock
    # for its own runtime.json writes. Holding it here would cause the
    # agent to see it as contention and skip the close.
    release_lifecycle_lock(lock_fd)
    lock_fd = None

    # Graceful shutdown: send /done --shutdown for full close
    print(f'[hermit] Sending /claude-code-hermit:done --shutdown to {session_name}...')
    subprocess.run([
        'tmux', 'send-keys', '-t', session_name,
        '/claude-code-hermit:done --shutdown', 'Enter',
    ])

    # Wait for /done to mark shutdown complete in runtime.json. Poll
    # shutdown_completed_at >= shutdown_requested_at (UTC-Z lexical compare
    # is safe since Step 3 standardized all writers).
    print(f'[hermit] Waiting up to {DEFAULT_TIMEOUT}s for /done to complete shutdown...')
    closed = False
    for i in range(DEFAULT_TIMEOUT):
        time.sleep(1)
        if not session_exists(session_name):
            print('[hermit] Session exited.')
            closed = True
            break
        runtime = read_runtime_json() or {}
        done_at = runtime.get('shutdown_completed_at')
        req_at = runtime.get('shutdown_requested_at')
        if done_at and (not req_at or done_at >= req_at):
            print(f'[hermit] /done completed after {i}s.')
            closed = True
            break
    if not closed:
        print(f'[hermit] Timeout after {DEFAULT_TIMEOUT}s. Killing session.')

    # Re-acquire lock for final state writes and cleanup
    lock_fd = acquire_lifecycle_lock()

    # Reset always_on flag
    config['always_on'] = False
    save_config(config)

    # Kill tmux session
    if session_exists(session_name):
        subprocess.run(['tmux', 'kill-session', '-t', session_name])
        print(f'[hermit] tmux session "{session_name}" terminated.')

    # Mark shutdown completed in runtime.json. The /done path normally does this;
    # we set it defensively in case /done didn't fire (e.g., timeout).
    update_runtime_field({
        'session_state': 'idle',
        'shutdown_completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    })


if __name__ == '__main__':
    main()
