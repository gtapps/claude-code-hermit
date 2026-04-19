#!/usr/bin/env python3
"""Boot script for hermit autonomous sessions.

Reads .claude-code-hermit/config.json and starts Claude Code
in a tmux session with the configured channels and options.

Usage:
    python scripts/hermit-start.py              # from project root
    python scripts/hermit-start.py --no-tmux    # run in current terminal
"""

import fcntl
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path('.claude-code-hermit/config.json')
STATE_DIR = CONFIG_PATH.parent / 'state'
RUNTIME_JSON = STATE_DIR / 'runtime.json'
RUNTIME_TMP = STATE_DIR / '.runtime.json.tmp'
LIFECYCLE_LOCK = STATE_DIR / '.lifecycle.lock'
PROFILE_LEVELS = {'minimal': 0, 'standard': 1, 'strict': 2}

DEFAULT_CONFIG = {
    '_hermit_versions': {},
    'agent_name': None,
    'language': None,
    'timezone': None,
    'escalation': 'balanced',
    'sign_off': None,
    'channels': {},
    'remote': True,
    'model': None,
    'permission_mode': 'acceptEdits',
    'tmux_session_name': 'hermit-{project_name}',
    'scope': 'local',
    'auto_session': True,
    'ask_budget': False,
    'always_on': False,
    'chrome': False,
    'idle_behavior': 'discover',
    'idle_budget': '$0.50',
    'routines': [
        {'id': 'heartbeat-restart', 'schedule': '0 4 * * *', 'skill': 'claude-code-hermit:heartbeat start', 'run_during_waiting': True, 'enabled': True},
        {'id': 'weekly-review', 'schedule': '0 23 * * 0', 'skill': 'claude-code-hermit:weekly-review', 'enabled': False},
    ],
    'monitors': [],
    'env': {
        'AGENT_HOOK_PROFILE': 'standard',
        'COMPACT_THRESHOLD': '50',
        'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': '50',
        'MAX_THINKING_TOKENS': '10000',
    },
    'plugin_checks': [],
    'docker': {
        'packages': [],
        'recommended_plugins': [],
    },
    'compact': {
        'monitoring_threshold': 30,
        'monitoring_keep': 20,
        'summary_threshold': 30,
        'summary_keep': 15,
    },
    'heartbeat': {
        'enabled': True,
        'every': '2h',
        'show_ok': False,
        'active_hours': {
            'start': '08:00',
            'end': '23:00',
        },
        'stale_threshold': '2h',
        'waiting_timeout': None,
    },
    'knowledge': {
        'raw_retention_days': 14,
        'compiled_budget_chars': 1000,
        'working_set_warn': 20,
    },
}


def load_config():
    """Load config.json or return defaults."""
    if not CONFIG_PATH.exists():
        print(f'[hermit] No config found at {CONFIG_PATH}')
        print('[hermit] Run /claude-code-hermit:hatch inside Claude Code first.')
        sys.exit(1)

    with open(CONFIG_PATH) as f:
        config = json.load(f)

    # Merge with defaults — shallow for top-level, deep for nested dicts.
    # Values in config may be None (JSON null), so fall back to {} for unpacking.
    merged = {**DEFAULT_CONFIG, **config}
    for key, default in DEFAULT_CONFIG.items():
        if isinstance(default, dict):
            merged[key] = {**default, **(config.get(key) or {})}
    # One more level for heartbeat.active_hours
    if 'active_hours' in DEFAULT_CONFIG.get('heartbeat', {}):
        merged_hb = merged.get('heartbeat', {})
        merged_hb['active_hours'] = {
            **DEFAULT_CONFIG['heartbeat']['active_hours'],
            **((config.get('heartbeat') or {}).get('active_hours') or {}),
        }
        merged['heartbeat'] = merged_hb
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
            print('[hermit] Run /claude-code-hermit:hermit-evolve inside Claude Code')
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


def write_runtime_json(data):
    """Atomic write to state/runtime.json."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    data['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    RUNTIME_TMP.write_text(json.dumps(data, indent=2) + '\n')
    RUNTIME_TMP.rename(RUNTIME_JSON)


def read_runtime_json():
    """Read state/runtime.json, return None if missing or invalid."""
    try:
        with open(RUNTIME_JSON) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def tmux_session_alive(session_name):
    return subprocess.run(
        ['tmux', 'has-session', '-t', session_name],
        capture_output=True,
    ).returncode == 0


def check_stale_runtime(config, session_name):
    """Check for stale runtime state from a previous run and warn."""
    runtime = read_runtime_json()
    if runtime is None:
        return

    state = runtime.get('session_state')
    mode = runtime.get('runtime_mode')
    shutdown_completed = runtime.get('shutdown_completed_at')

    if state in ('in_progress', 'waiting', 'suspect_process'):
        if mode in ('tmux', 'docker'):
            # Check if the tmux session from the previous run still exists
            prev_tmux = runtime.get('tmux_session', '')
            if not tmux_session_alive(prev_tmux):
                print(f'[hermit] Warning: Previous session crashed (runtime.json says '
                      f'{state}, tmux session "{prev_tmux}" is gone).')
                print('[hermit] /session-start will offer recovery.')
                runtime['last_error'] = 'unclean_shutdown'
                write_runtime_json(runtime)
        elif mode == 'interactive' and not shutdown_completed:
            print('[hermit] Warning: Previous interactive session did not close cleanly.')
            print('[hermit] /session-start will offer recovery.')
            runtime['last_error'] = 'unclean_shutdown'
            write_runtime_json(runtime)

    if runtime.get('last_error') == 'session_died_on_boot':
        print('[hermit] Note: previous start failed (tmux session died on boot).')

    # Check for interrupted transitions
    transition = runtime.get('transition')
    if transition:
        print(f'[hermit] Warning: Interrupted transition detected: {transition} '
              f'(target: {runtime.get("transition_target", "unknown")})')
        print('[hermit] /session-start will resume or clean up.')


def acquire_lifecycle_lock():
    """Acquire exclusive lifecycle lock. Returns fd or exits on contention."""
    if sys.platform == 'win32':
        print('[hermit] Always-on mode requires Linux, macOS, or WSL2. See docs/faq.md.')
        sys.exit(1)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_fd = open(LIFECYCLE_LOCK, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('[hermit] Another lifecycle operation in progress. Aborting.')
        sys.exit(1)
    return lock_fd


CHANNEL_PLUGINS = {
    'discord': 'plugin:discord@claude-plugins-official',
    'telegram': 'plugin:telegram@claude-plugins-official',
    'imessage': 'plugin:imessage@claude-plugins-official',
}


def iter_channel_configs(config):
    """Yield (name, cfg) for channels whose config is a valid dict."""
    channels = config.get('channels', {})
    if not isinstance(channels, dict):
        return
    for name, cfg in channels.items():
        if isinstance(cfg, dict):
            yield name, cfg


def get_enabled_channels(config):
    """Return list of enabled channel names."""
    return [name for name, cfg in iter_channel_configs(config) if cfg.get('enabled', True)]


def resolve_state_dir(state_dir):
    """Resolve a state_dir path (absolute pass-through, relative against cwd)."""
    p = Path(state_dir)
    return p if p.is_absolute() else Path.cwd() / p


def build_claude_command(config, tools):
    """Build the claude launch command from config."""
    cmd = ['claude']

    enabled_channels = get_enabled_channels(config)
    if enabled_channels:
        # Bun is required for all channel plugins.
        if not tools.get('bun'):
            names = ', '.join(enabled_channels)
            print(f'[hermit] WARNING: channels skipped ({names}) — bun is not installed.')
            print(f'[hermit]   Install bun: https://bun.sh')
            print(f'[hermit]   Then run /claude-code-hermit:channel-setup to activate.')
            enabled_channels = []

        active_channels = []
        for channel, ch_cfg in iter_channel_configs(config):
            if channel not in enabled_channels:
                continue

            # Warn if the token file is missing — still add the channel so the
            # plugin can surface its own auth error.
            state_dir = ch_cfg.get('state_dir', f'.claude.local/channels/{channel}')
            if not (resolve_state_dir(state_dir) / '.env').exists():
                print(f'[hermit] WARNING: channel "{channel}" has no token configured.')
                print(f'[hermit]   Run /claude-code-hermit:channel-setup to add it.')

            active_channels.append(channel)

        if active_channels:
            cmd.append('--channels')
            for channel in active_channels:
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

    if config.get('chrome'):
        if is_container():
            print('[hermit] WARNING: chrome=true ignored — browser not available in containers.')
        else:
            cmd.append('--chrome')

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
    elif mode in ('acceptEdits', 'plan', 'dontAsk'):
        cmd.extend(['--permission-mode', mode])
    elif mode not in ('default', None):
        print(f'[hermit] WARNING: unknown permission_mode "{mode}" — skipping (using default)')

    return cmd


def get_session_name(config):
    """Resolve tmux session name from config."""
    name = config.get('tmux_session_name', 'hermit-{project_name}')
    project_name = Path.cwd().name
    return name.replace('{project_name}', project_name)


def write_settings_env(config):
    """Write config env vars to .claude/settings.local.json.

    Claude Code reads the `env` key from settings.json and exports those
    values to all subprocesses (hooks, MCP servers, Bash tool calls).
    This is the canonical way to set env vars per the official docs.

    Auth vars (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR) are NOT written here —
    they must be in the shell env before claude launches. OAuth credentials
    live in .credentials.json (written by `claude /login`).
    """
    settings_path = Path('.claude/settings.local.json')
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        settings = {}

    if 'env' not in settings:
        settings['env'] = {}

    env_vars = dict(config.get('env', {}))  # copy — don't mutate config

    # AGENT_HOOK_PROFILE is process-scoped: forwarded via tmux env file or
    # docker-compose environment block. NOT written to settings.local.json,
    # which is shared between container and host via bind mount.
    profile = env_vars.pop('AGENT_HOOK_PROFILE', None) \
        or os.environ.get('AGENT_HOOK_PROFILE', 'standard')
    if profile not in PROFILE_LEVELS:
        print(f'[hermit] Warning: invalid AGENT_HOOK_PROFILE={profile}, defaulting to standard')
        profile = 'standard'
    if config.get('always_on'):
        floor = 'standard'  # non-negotiable minimum for always-on
        if PROFILE_LEVELS[profile] < PROFILE_LEVELS[floor]:
            print(f'[hermit] Warning: AGENT_HOOK_PROFILE={profile} below always-on '
                  f'floor, forcing to {floor}')
            profile = floor
    os.environ.setdefault('AGENT_HOOK_PROFILE', profile)

    if env_vars:
        settings['env'].update(env_vars)

    # Migration: remove AGENT_HOOK_PROFILE from settings.local.json if present
    # (older versions wrote it there, causing host/container leak)
    settings['env'].pop('AGENT_HOOK_PROFILE', None)

    # MCP servers (channel plugins) are separate processes that inherit OS env —
    # they don't read settings.local.json directly. Without *_STATE_DIR the
    # plugin defaults to ~/.claude/channels/<plugin>/, which is lost on Docker
    # container restart.
    for ch_name, ch_cfg in iter_channel_configs(config):
        state_dir = ch_cfg.get('state_dir')
        if state_dir:
            # Relative paths resolved against project root (cwd at boot).
            # In Docker, compose sets *_STATE_DIR via ${PWD} (host-side);
            # this expansion covers the non-Docker (tmux) boot path.
            settings['env'][f'{ch_name.upper()}_STATE_DIR'] = str(resolve_state_dir(state_dir))

    # Remove channel bot tokens — they must only live in
    # .claude.local/channels/<plugin>/.env. A stale token here
    # overrides the file via process.env and fails silently.
    stale_keys = [k for k in settings['env']
                  if k.endswith('_BOT_TOKEN')]
    for key in stale_keys:
        del settings['env'][key]
    if stale_keys:
        print(f'[hermit] Cleaned stale token vars from settings.local.json: {", ".join(stale_keys)}')

    with open(settings_path, 'w') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')

    if env_vars:
        print(f'[hermit] Env: {len(env_vars)} vars written to .claude/settings.local.json')


def main():
    no_tmux_flag = '--no-tmux' in sys.argv

    config = load_config()
    lock_fd = acquire_lifecycle_lock()
    check_for_upgrade(config)
    tools = check_prerequisites()
    cmd = build_claude_command(config, tools)
    session_name = get_session_name(config)

    # Check for stale state from a previous run
    check_stale_runtime(config, session_name)

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
    print(f'[hermit] Channels: {", ".join(get_enabled_channels(config)) or "none"}')
    print(f'[hermit] Remote: {"enabled" if config.get("remote") else "disabled"}')
    print(f'[hermit] Chrome: {"enabled" if config.get("chrome") else "disabled"}')
    print(f'[hermit] Permissions: {config.get("permission_mode") or "acceptEdits"}')

    write_settings_env(config)

    if no_tmux_flag or not tools['tmux']:
        if not no_tmux_flag and not tools['tmux']:
            print('[hermit] tmux not found — running in current terminal.')
            print('[hermit] Install tmux for persistent sessions.')
        # Create or update runtime.json for interactive mode
        existing = read_runtime_json()
        if existing is None:
            write_runtime_json({
                'version': 1,
                'session_state': 'idle',
                'session_id': None,
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                'runtime_mode': 'interactive',
                'tmux_session': None,
                'transition': None,
                'transition_target': None,
                'transition_started_at': None,
                'shutdown_requested_at': None,
                'shutdown_completed_at': None,
                'last_error': None,
            })
        else:
            # Preserve lifecycle fields for session-start recovery
            existing['version'] = 1
            existing['runtime_mode'] = 'interactive'
            existing['tmux_session'] = None
            write_runtime_json(existing)
        print(f'[hermit] Running: {shlex.join(cmd)}')
        os.execvp(cmd[0], cmd)

    # Start tmux session (handles "already exists" as a graceful exit)
    #
    # tmux starts a new shell that does NOT inherit the caller's environment.
    # Auth vars must be in shell env before claude launches.
    # *_STATE_DIR vars must be OS env because MCP servers (channel plugins)
    # inherit shell env but don't read settings.local.json.
    forward_vars = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'AGENT_HOOK_PROFILE']
    # *_STATE_DIR vars must reach MCP servers via OS env — see write_settings_env.
    for ch_name, ch_cfg in iter_channel_configs(config):
        if ch_cfg.get('state_dir'):
            forward_vars.append(f'{ch_name.upper()}_STATE_DIR')
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
        stderr_msg = result.stderr.decode().strip() if result.stderr else ''
        if 'duplicate session' in stderr_msg:
            print(f'[hermit] Session "{session_name}" already running (always-on).')
            print(f'[hermit] Attach: tmux attach -t {session_name}')
            print(f'[hermit] Send tasks via channel, or run hermit-stop to shut down.')
            sys.exit(0)
        else:
            print(f'[hermit] ERROR: tmux new-session failed.')
            if stderr_msg:
                print(f'[hermit]   tmux: {stderr_msg}')
            sys.exit(1)

    print(f'[hermit] Started tmux session: {session_name}')

    # Detect runtime mode
    runtime_mode = 'docker' if is_container() else 'tmux'

    # Create or update runtime.json as the single source of lifecycle truth
    existing = read_runtime_json()
    if existing is None:
        write_runtime_json({
            'version': 1,
            'session_state': 'idle',
            'session_id': None,
            'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'runtime_mode': runtime_mode,
            'tmux_session': session_name,
            'transition': None,
            'transition_target': None,
            'transition_started_at': None,
            'shutdown_requested_at': None,
            'shutdown_completed_at': None,
            'last_error': None,
        })
    else:
        # Preserve lifecycle fields for session-start recovery
        existing['version'] = 1
        existing['runtime_mode'] = runtime_mode
        existing['tmux_session'] = session_name
        write_runtime_json(existing)

    # Mark as always-on mode in config
    config['always_on'] = True
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)
            f.write('\n')
    except OSError:
        pass

    # Verify the session survived the boot period before sending any keys
    time.sleep(3)  # Wait for Claude to boot — increase if on slow hardware
    if not tmux_session_alive(session_name):
        print(f'[hermit] ERROR: tmux session "{session_name}" died after creation.')
        print('[hermit] The shell command inside tmux likely failed.')
        print('[hermit] Common causes: `claude` not in PATH, missing ANTHROPIC_API_KEY.')
        print(f'[hermit] To debug: tmux new-session -s hermit-debug then run `claude` manually.')
        print('[hermit] Falling back to interactive mode...')
        existing = read_runtime_json()
        existing['runtime_mode'] = 'interactive'
        existing['tmux_session'] = None
        existing['last_error'] = 'session_died_on_boot'
        write_runtime_json(existing)
        os.execvp(cmd[0], cmd)

    # Bootstrap: send ONE composite prompt so all startup commands execute in a single
    # Claude turn. Three separate `tmux send-keys` raced — the second/third landed inside
    # the still-running /session turn and were silently swallowed (same failure mode as
    # the old routine-watcher's send-keys). One prompt = one turn = no race.
    hb = config.get('heartbeat', {})
    auto_session = config.get('auto_session', True)
    hb_enabled = hb.get('enabled', False)
    has_routines = bool(config.get('routines'))

    steps = []
    if hb_enabled:
        steps.append('/claude-code-hermit:heartbeat start')
    if has_routines:
        steps.append('/claude-code-hermit:routines load')
    if auto_session:
        steps.append('/claude-code-hermit:session')

    if steps:
        if len(steps) == 1:
            bootstrap = steps[0]
        else:
            numbered = ', '.join(f'({i+1}) {s}' for i, s in enumerate(steps))
            bootstrap = f'Always-on bootstrap. Invoke these skills in order: {numbered}.'
        subprocess.run(
            ['tmux', 'send-keys', '-t', session_name, bootstrap, 'Enter'],
        )

    if hb_enabled:
        print(f'[hermit] Bootstrap: /claude-code-hermit:heartbeat start queued (every {hb.get("every", "30m")})')
    else:
        print('[hermit] Heartbeat: disabled')
    if has_routines:
        print('[hermit] Bootstrap: /claude-code-hermit:routines load queued')
    if auto_session:
        print('[hermit] Bootstrap: /claude-code-hermit:session queued')

    print(f'[hermit] Mode: always-on (session stays open between tasks)')
    print(f'[hermit] Attach: tmux attach -t {session_name}')
    print(f'[hermit] Stop: python scripts/hermit-stop.py')


if __name__ == '__main__':
    main()
