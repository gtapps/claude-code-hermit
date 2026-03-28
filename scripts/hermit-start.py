#!/usr/bin/env python3
"""Boot script for hermit autonomous sessions.

Reads .claude-code-hermit/config.json and starts Claude Code
in a tmux session with the configured channels and options.

Usage:
    python scripts/hermit-start.py              # from project root
    python scripts/hermit-start.py --no-tmux    # run in current terminal
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path('.claude-code-hermit/config.json')
DEFAULT_CONFIG = {
    '_hermit_versions': {},
    '_plugin_root': None,
    'agent_name': None,
    'language': None,
    'timezone': None,
    'escalation': 'balanced',
    'sign_off': None,
    'channels': [],
    'remote': True,
    'model': None,
    'permission_mode': 'acceptEdits',
    'tmux_session_name': 'hermit-{project_name}',
    'auto_session': True,
    'ask_budget': False,
    'always_on': False,
    'morning_brief': None,
    'heartbeat': {
        'enabled': True,
        'every': '30m',
        'show_ok': False,
        'active_hours': {
            'start': '08:00',
            'end': '23:00',
        },
        'self_eval_interval': 20,
        'total_ticks': 0,
    },
}


def load_config():
    """Load config.json or return defaults."""
    if not CONFIG_PATH.exists():
        print(f'[hermit] No config found at {CONFIG_PATH}')
        print('[hermit] Run /claude-code-hermit:init inside Claude Code first.')
        sys.exit(1)

    with open(CONFIG_PATH) as f:
        config = json.load(f)

    # Merge with defaults for any missing keys
    merged = {**DEFAULT_CONFIG, **config}
    return merged


def check_for_upgrade(config):
    """Print a notice if the plugin version is newer than config version."""
    plugin_json = Path(__file__).resolve().parent.parent / '.claude-plugin' / 'plugin.json'
    try:
        with open(plugin_json) as f:
            plugin_ver = json.load(f).get('version', '0.0.0')
        config_ver = config.get('_hermit_versions', {}).get('claude-code-hermit', '0.0.0')
        if plugin_ver != config_ver:
            print(f'[hermit] Upgrade available: v{config_ver} -> v{plugin_ver}')
            print('[hermit] Run /claude-code-hermit:upgrade inside Claude Code')
    except (OSError, ValueError, KeyError):
        pass


def check_prerequisites():
    """Check that required tools are available."""
    errors = []

    # Claude Code
    if not shutil.which('claude'):
        errors.append('claude: Claude Code CLI not found. Install from https://claude.ai/download')

    # tmux (optional but recommended)
    has_tmux = shutil.which('tmux') is not None

    # bun (optional, for channel plugins)
    has_bun = shutil.which('bun') is not None

    if errors:
        for err in errors:
            print(f'[hermit] ERROR: {err}')
        sys.exit(1)

    return {'tmux': has_tmux, 'bun': has_bun}


def is_container():
    """Detect if running inside a container (Docker, Podman, LXC)."""
    return (
        os.path.exists('/.dockerenv')
        or os.path.exists('/run/.containerenv')
        or os.environ.get('container') == 'docker'
    )


CHANNEL_PLUGINS = {
    'discord': 'plugin:discord@claude-plugins-official',
    'telegram': 'plugin:telegram@claude-plugins-official',
    'imessage': 'plugin:imessage@claude-plugins-official',
}


def build_claude_command(config):
    """Build the claude launch command from config."""
    cmd = ['claude']

    channels = config.get('channels', [])
    if channels:
        cmd.append('--channels')
        for channel in channels:
            plugin_id = CHANNEL_PLUGINS.get(channel)
            if plugin_id:
                cmd.append(plugin_id)
            else:
                print(f'[hermit] WARNING: unrecognized channel "{channel}" — expected discord, telegram, or imessage')
                cmd.append(channel)

    # Add remote control for web/mobile access (with session name)
    if config.get('remote', False):
        remote_name = config.get('agent_name') or get_session_name(config)
        cmd.extend(['--remote-control', remote_name])

    if config.get('model'):
        cmd.extend(['--model', config['model']])

    mode = config.get('permission_mode', 'acceptEdits')
    if mode == 'bypassPermissions':
        if not is_container():
            print('[hermit] WARNING: bypassPermissions is intended for containers/VMs only.')
            print('[hermit] You appear to be running on a host machine.')
            try:
                answer = input('[hermit] Continue anyway? [y/N] ').strip().lower()
            except EOFError:
                answer = ''
            if answer != 'y':
                print('[hermit] Aborted. Change permission_mode in config.json or use a container.')
                sys.exit(1)
        cmd.append('--dangerously-skip-permissions')
    elif mode in ('acceptEdits', 'dontAsk'):
        cmd.extend(['--permission-mode', mode])
    elif mode not in ('default', None):
        print(f'[hermit] WARNING: unknown permission_mode "{mode}" — skipping (using default)')

    return cmd


def get_session_name(config):
    """Resolve tmux session name from config."""
    name = config.get('tmux_session_name', 'hermit-{project_name}')
    project_name = Path.cwd().name
    return name.replace('{project_name}', project_name)


def main():
    no_tmux_flag = '--no-tmux' in sys.argv

    config = load_config()
    check_for_upgrade(config)
    tools = check_prerequisites()
    cmd = build_claude_command(config)
    session_name = get_session_name(config)

    # Print launch info
    agent_name = config.get('agent_name')
    language = config.get('language')
    timezone = config.get('timezone')
    if agent_name:
        identity_parts = [agent_name]
        if language:
            identity_parts.append(language)
        if timezone:
            identity_parts.append(timezone)
        print(f'[hermit] Agent: {", ".join(identity_parts)}')
    else:
        print('[hermit] Agent: (unnamed)')
    print(f'[hermit] Project: {Path.cwd().name}')
    print(f'[hermit] Model: {config.get("model") or "default"}')
    print(f'[hermit] Channels: {", ".join(config.get("channels", [])) or "none"}')
    print(f'[hermit] Remote: {"enabled" if config.get("remote") else "disabled"}')
    print(f'[hermit] Permissions: {config.get("permission_mode") or "acceptEdits"}')

    if no_tmux_flag or not tools['tmux']:
        if not no_tmux_flag and not tools['tmux']:
            print('[hermit] tmux not found — running in current terminal.')
            print('[hermit] Install tmux for persistent sessions.')
        print(f'[hermit] Running: {shlex.join(cmd)}')
        os.execvp(cmd[0], cmd)
        return

    # Start tmux session (handles "already exists" as a graceful exit)
    #
    # tmux starts a new shell that does NOT inherit the caller's environment.
    # Write forwarded vars to a temp env file and source it — this avoids
    # leaking secrets (OAuth tokens, API keys) into the process list via ps.
    forward_vars = [
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
        'AGENT_HOOK_PROFILE',
        'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'MAX_THINKING_TOKENS',
        'DISCORD_STATE_DIR', 'TELEGRAM_STATE_DIR',
    ]
    env_file = Path('/tmp') / f'.hermit-env-{session_name}'
    with open(env_file, 'w') as f:
        for var in forward_vars:
            val = os.environ.get(var)
            if val is not None:
                f.write(f'export {var}={shlex.quote(val)}\n')
    os.chmod(env_file, 0o600)

    shell_cmd = f'. {shlex.quote(str(env_file))} && rm -f {shlex.quote(str(env_file))} && {shlex.join(cmd)}'
    result = subprocess.run(
        ['tmux', 'new-session', '-d', '-s', session_name, shell_cmd],
        capture_output=True,
    )
    if result.returncode != 0:
        print(f'[hermit] Session "{session_name}" already running (always-on).')
        print(f'[hermit] Attach: tmux attach -t {session_name}')
        print(f'[hermit] Send tasks via channel, or run hermit-stop to shut down.')
        sys.exit(0)

    print(f'[hermit] Started tmux session: {session_name}')

    # Mark as always-on mode in config
    config['always_on'] = True
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)
            f.write('\n')
    except OSError:
        pass

    # Auto-run /session if configured
    if config.get('auto_session', True):
        time.sleep(3)  # Wait for Claude to boot — increase if on slow hardware
        subprocess.run(
            ['tmux', 'send-keys', '-t', session_name,
             '/claude-code-hermit:session', 'Enter'],
        )
        print('[hermit] Auto-sent /claude-code-hermit:session')

    # Start heartbeat if enabled
    hb = config.get('heartbeat', {})
    if hb.get('enabled', False):
        time.sleep(2)  # Wait for /session to initialize
        subprocess.run(
            ['tmux', 'send-keys', '-t', session_name,
             '/claude-code-hermit:heartbeat start', 'Enter'],
        )
        print(f'[hermit] Heartbeat started (every {hb.get("every", "30m")})')
    else:
        print('[hermit] Heartbeat: disabled')

    print(f'[hermit] Mode: always-on (session stays open between tasks)')
    print(f'[hermit] Attach: tmux attach -t {session_name}')
    print(f'[hermit] Stop: python scripts/hermit-stop.py')


if __name__ == '__main__':
    main()
