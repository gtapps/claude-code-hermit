#!/usr/bin/env python3
"""Contract tests for claude-code-hermit.

Only add tests for silent breakage — not for every branch in every helper.
Tests cover: config template/runtime sync, boot merge logic, hook outputs, negative paths.

Usage: python3 tests/run-contracts.py [-v]
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / 'tests' / 'fixtures'
SCRIPTS = REPO / 'scripts'


def _import_script(name, filename):
    """Import a Python script with a hyphenated filename."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hermit_start = _import_script('hermit_start', 'hermit-start.py')


def _flatten_keys(obj, prefix=''):
    """Flatten a nested dict to dot-separated key paths."""
    keys = set()
    for k, v in obj.items():
        path = f'{prefix}.{k}' if prefix else k
        keys.add(path)
        if isinstance(v, dict):
            keys |= _flatten_keys(v, path)
    return keys


class _TempDirTest(unittest.TestCase):
    """Base class that creates a temp dir and chdir into it."""

    def setUp(self):
        self._orig_dir = os.getcwd()
        self._tmpdir = tempfile.mkdtemp()
        os.chdir(self._tmpdir)
        os.makedirs('.claude-code-hermit/state', exist_ok=True)
        os.makedirs('.claude', exist_ok=True)

    def tearDown(self):
        os.chdir(self._orig_dir)
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        os.environ.pop('AGENT_HOOK_PROFILE', None)

    def _write_config(self, config):
        with open('.claude-code-hermit/config.json', 'w') as f:
            json.dump(config, f)

    def _write_settings(self, settings):
        os.makedirs('.claude', exist_ok=True)
        with open('.claude/settings.local.json', 'w') as f:
            json.dump(settings, f)

    def _read_settings(self):
        with open('.claude/settings.local.json') as f:
            return json.load(f)


# ============================================================
# Config contract tests
# ============================================================

class TestConfigContract(unittest.TestCase):
    """Template and DEFAULT_CONFIG must mirror — load_config() merges with
    DEFAULT_CONFIG, so any template key missing from defaults silently loses
    its fallback for sparse configs."""

    @classmethod
    def setUpClass(cls):
        with open(REPO / 'state-templates' / 'config.json.template') as f:
            cls.template = json.load(f)
        cls.defaults = hermit_start.DEFAULT_CONFIG

    # Keys that exist only in template — consumed by scripts that handle
    # their own missing-key logic (not part of load_config merge).
    TEMPLATE_ONLY_KEYS = {
        'idle_behavior', 'idle_budget', 'routines', 'monitors',
        'compact', 'compact.monitoring_threshold', 'compact.monitoring_keep',
        'compact.summary_threshold', 'compact.summary_keep',
        'docker.recommended_plugins',
    }

    def test_key_path_sync(self):
        """Flattened key paths must match (excluding known template-only keys)."""
        template_keys = _flatten_keys(self.template)
        default_keys = _flatten_keys(self.defaults)

        # Template keys missing from defaults (besides known exceptions)
        missing_from_defaults = template_keys - default_keys - self.TEMPLATE_ONLY_KEYS
        self.assertEqual(missing_from_defaults, set(),
                         f'Template keys missing from DEFAULT_CONFIG: {missing_from_defaults}')

        # Default keys missing from template
        missing_from_template = default_keys - template_keys
        self.assertEqual(missing_from_template, set(),
                         f'DEFAULT_CONFIG keys missing from template: {missing_from_template}')

    def test_type_sync(self):
        """For shared key paths, types must match (null/None both OK)."""
        template_flat = {}
        self._flatten_typed(self.template, '', template_flat)
        default_flat = {}
        self._flatten_typed(self.defaults, '', default_flat)

        shared = set(template_flat) & set(default_flat)
        mismatches = []
        for key in sorted(shared):
            t_type = template_flat[key]
            d_type = default_flat[key]
            # None/null matches any type (it's a valid default)
            if t_type is None or d_type is None:
                continue
            if t_type != d_type:
                mismatches.append(f'{key}: template={t_type.__name__}, default={d_type.__name__}')

        self.assertEqual(mismatches, [],
                         f'Type mismatches between template and DEFAULT_CONFIG:\n' +
                         '\n'.join(mismatches))

    @staticmethod
    def _flatten_typed(obj, prefix, out):
        for k, v in obj.items():
            path = f'{prefix}.{k}' if prefix else k
            out[path] = type(v) if v is not None else None
            if isinstance(v, dict):
                TestConfigContract._flatten_typed(v, path, out)

    def test_quality_gate_tier_enum(self):
        """quality_gate.tier in template + DEFAULT_CONFIG must be in the
        budget/balanced/quality enum. Catches typos in either source."""
        valid_tiers = {'budget', 'balanced', 'quality'}

        template_tier = self.template.get('quality_gate', {}).get('tier')
        self.assertIn(template_tier, valid_tiers,
                      f'template quality_gate.tier={template_tier!r} not in {valid_tiers}')

        default_tier = self.defaults.get('quality_gate', {}).get('tier')
        self.assertIn(default_tier, valid_tiers,
                      f'DEFAULT_CONFIG quality_gate.tier={default_tier!r} not in {valid_tiers}')


class TestConfigMerge(_TempDirTest):

    def test_sparse_config_merge(self):
        """Sparse config with one key should get all defaults."""
        self._write_config({'agent_name': 'Test'})
        merged = hermit_start.load_config()
        default_paths = _flatten_keys(hermit_start.DEFAULT_CONFIG)
        merged_paths = _flatten_keys(merged)
        missing = default_paths - merged_paths
        self.assertEqual(missing, set(),
                         f'Default keys missing after sparse merge: {missing}')
        self.assertEqual(merged['agent_name'], 'Test')

    def test_nested_env_no_clobber(self):
        """User env override doesn't lose other env keys."""
        self._write_config({'env': {'COMPACT_THRESHOLD': '100'}})
        merged = hermit_start.load_config()
        self.assertEqual(merged['env']['COMPACT_THRESHOLD'], '100')
        self.assertIn('MAX_THINKING_TOKENS', merged['env'])
        self.assertEqual(merged['env']['MAX_THINKING_TOKENS'], '10000')

    def test_heartbeat_active_hours_deep_merge(self):
        """Custom heartbeat.active_hours.start preserves default end."""
        self._write_config({'heartbeat': {'active_hours': {'start': '09:00'}}})
        merged = hermit_start.load_config()
        self.assertEqual(merged['heartbeat']['active_hours']['start'], '09:00')
        self.assertEqual(merged['heartbeat']['active_hours']['end'], '23:00')

    def test_missing_config_exits(self):
        """No config.json should cause sys.exit(1)."""
        # Remove the config if it exists
        cfg = Path('.claude-code-hermit/config.json')
        if cfg.exists():
            cfg.unlink()
        with self.assertRaises(SystemExit) as ctx:
            hermit_start.load_config()
        self.assertEqual(ctx.exception.code, 1)


# ============================================================
# Boot logic tests
# ============================================================

class TestChannelFiltering(unittest.TestCase):

    def test_mixed_channels(self):
        """Only enabled dict channels returned."""
        config = {
            'channels': {
                'discord': {'enabled': True},
                'telegram': {'enabled': False},
                'bad': 'string',
            }
        }
        result = hermit_start.get_enabled_channels(config)
        self.assertEqual(result, ['discord'])

    def test_empty_channels(self):
        self.assertEqual(hermit_start.get_enabled_channels({'channels': {}}), [])

    def test_non_dict_channels(self):
        """Non-dict channels value doesn't crash."""
        self.assertEqual(hermit_start.get_enabled_channels({'channels': 'string'}), [])
        self.assertEqual(hermit_start.get_enabled_channels({'channels': ['list']}), [])


class TestBuildClaudeCommandChannels(_TempDirTest):
    """build_claude_command: channel resolution for --channels arg.

    Silent-breakage zone — if this resolves wrong, claude exits at boot
    and the tmux session dies before the operator sees a useful error.
    """

    def _tools(self):
        return {'bun': '/usr/local/bin/bun'}

    def _state_dir_with_env(self, channel):
        # build_claude_command checks <state_dir>/.env existence and warns if missing.
        # We don't assert on the warning — we only care about the --channels payload.
        d = Path(f'.claude.local/channels/{channel}')
        d.mkdir(parents=True, exist_ok=True)
        (d / '.env').write_text('TOKEN=stub\n')
        return str(d)

    def _capture(self, fn):
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = fn()
        return result, buf.getvalue()

    @patch.object(hermit_start, '_fetch_registered_marketplaces', return_value=None)
    def test_builtin_channel_resolves_via_hardcoded_dict(self, _mock):
        state_dir = self._state_dir_with_env('discord')
        config = {'channels': {'discord': {'enabled': True, 'state_dir': state_dir}}}
        cmd = hermit_start.build_claude_command(config, self._tools())
        self.assertIn('--channels', cmd)
        self.assertIn('plugin:discord@claude-plugins-official', cmd)

    @patch.object(hermit_start, '_fetch_registered_marketplaces', return_value=None)
    def test_third_party_channel_uses_config_marketplace(self, _mock):
        state_dir = self._state_dir_with_env('matrix')
        config = {
            'channels': {
                'matrix': {
                    'enabled': True,
                    'state_dir': state_dir,
                    'marketplace': 'someone/matrix-plugin',
                }
            }
        }
        cmd = hermit_start.build_claude_command(config, self._tools())
        self.assertIn('--channels', cmd)
        self.assertIn('plugin:matrix@someone/matrix-plugin', cmd)
        # Hardcoded official ID must NOT appear for non-built-in channels.
        for tok in cmd:
            self.assertFalse(
                tok.endswith('@claude-plugins-official') and tok.startswith('plugin:matrix@'),
                f'unexpected built-in resolution for third-party channel: {tok}',
            )

    @patch.object(hermit_start, '_fetch_registered_marketplaces', return_value=None)
    def test_unknown_channel_without_marketplace_falls_through(self, _mock):
        # No CHANNEL_PLUGINS entry, no channels.<name>.marketplace → bare name appended.
        # This preserves prior behaviour (claude will reject it) but is now accompanied
        # by a clearer warning pointing at the marketplace fix.
        state_dir = self._state_dir_with_env('signal')
        config = {'channels': {'signal': {'enabled': True, 'state_dir': state_dir}}}
        cmd = hermit_start.build_claude_command(config, self._tools())
        self.assertIn('--channels', cmd)
        self.assertIn('signal', cmd)
        self.assertNotIn('plugin:signal@claude-plugins-official', cmd)

    @patch.object(hermit_start, '_fetch_registered_marketplaces')
    def test_registered_marketplace_passes_through(self, mock_fetch):
        mock_fetch.return_value = [
            {'name': 'claude-plugins-official', 'repo': 'anthropics/claude-plugins-official'},
        ]
        state_dir = self._state_dir_with_env('discord')
        config = {'channels': {'discord': {'enabled': True, 'state_dir': state_dir}}}
        cmd = hermit_start.build_claude_command(config, self._tools())
        self.assertIn('--channels', cmd)
        self.assertIn('plugin:discord@claude-plugins-official', cmd)

    @patch.object(hermit_start, '_fetch_registered_marketplaces')
    def test_unregistered_marketplace_warns_and_drops(self, mock_fetch):
        mock_fetch.return_value = [
            {'name': 'claude-plugins-official', 'repo': 'anthropics/claude-plugins-official'},
        ]
        state_dir = self._state_dir_with_env('matrix')
        config = {'channels': {'matrix': {
            'enabled': True, 'state_dir': state_dir,
            'marketplace': 'someone-fork',
        }}}
        cmd, out = self._capture(
            lambda: hermit_start.build_claude_command(config, self._tools()))
        self.assertNotIn('plugin:matrix@someone-fork', cmd)
        self.assertNotIn('--channels', cmd)
        self.assertIn('matrix', out)
        self.assertIn('someone-fork', out)
        self.assertIn('not registered', out)
        self.assertIn('claude plugin marketplace add', out)

    @patch.object(hermit_start, '_fetch_registered_marketplaces')
    def test_unregistered_marketplace_repo_match_redirects(self, mock_fetch):
        mock_fetch.return_value = [
            {'name': 'matrix-plugin-official', 'repo': 'someone/matrix-plugin'},
        ]
        state_dir = self._state_dir_with_env('matrix')
        config = {'channels': {'matrix': {
            'enabled': True, 'state_dir': state_dir,
            'marketplace': 'someone/matrix-plugin',
        }}}
        cmd, out = self._capture(
            lambda: hermit_start.build_claude_command(config, self._tools()))
        self.assertNotIn('plugin:matrix@someone/matrix-plugin', cmd)
        self.assertIn('matrix-plugin-official', out)
        self.assertIn('repo', out.lower())

    @patch.object(hermit_start, '_fetch_registered_marketplaces', return_value=None)
    def test_channel_starting_with_dash_is_dropped(self, _mock):
        state_dir = self._state_dir_with_env('--evil')
        config = {'channels': {'--evil': {'enabled': True, 'state_dir': state_dir}}}
        cmd, out = self._capture(
            lambda: hermit_start.build_claude_command(config, self._tools()))
        self.assertNotIn('--evil', cmd)
        self.assertNotIn('--channels', cmd)
        self.assertIn('--evil', out)
        self.assertIn('-', out)


class TestWriteSettingsEnv(_TempDirTest):

    def test_stale_bot_token_removed(self):
        """BOT_TOKEN vars in settings are cleaned up."""
        self._write_settings({'env': {
            'DISCORD_BOT_TOKEN': 'stale-token',
            'TELEGRAM_BOT_TOKEN': 'another-stale',
        }})
        self._write_config({})
        config = hermit_start.load_config()
        hermit_start.write_settings_env(config)
        settings = self._read_settings()
        self.assertNotIn('DISCORD_BOT_TOKEN', settings['env'])
        self.assertNotIn('TELEGRAM_BOT_TOKEN', settings['env'])

    def test_state_dir_mapping(self):
        """Channel state_dir produces *_STATE_DIR in settings."""
        self._write_config({
            'channels': {
                'discord': {'enabled': True, 'state_dir': '/tmp/test-discord'},
            },
        })
        config = hermit_start.load_config()
        hermit_start.write_settings_env(config)
        settings = self._read_settings()
        self.assertEqual(settings['env']['DISCORD_STATE_DIR'], '/tmp/test-discord')

    def test_state_dir_relative_expanded(self):
        """Relative state_dir is expanded to absolute against cwd."""
        self._write_config({
            'channels': {
                'discord': {'enabled': True, 'state_dir': '.claude.local/channels/discord'},
            },
        })
        config = hermit_start.load_config()
        hermit_start.write_settings_env(config)
        settings = self._read_settings()
        expected = str(Path.cwd() / '.claude.local/channels/discord')
        self.assertEqual(settings['env']['DISCORD_STATE_DIR'], expected)

    def test_invalid_profile_corrected(self):
        """Invalid AGENT_HOOK_PROFILE defaults to standard in os.environ."""
        self._write_config({'env': {'AGENT_HOOK_PROFILE': 'garbage'}})
        config = hermit_start.load_config()
        os.environ.pop('AGENT_HOOK_PROFILE', None)
        hermit_start.write_settings_env(config)
        self.assertEqual(os.environ.get('AGENT_HOOK_PROFILE'), 'standard')
        settings = self._read_settings()
        self.assertNotIn('AGENT_HOOK_PROFILE', settings.get('env', {}))

    def test_always_on_profile_floor(self):
        """always_on forces minimal profile up to standard in os.environ."""
        self._write_config({
            'always_on': True,
            'env': {'AGENT_HOOK_PROFILE': 'minimal'},
        })
        config = hermit_start.load_config()
        self.assertTrue(config.get('always_on'), 'Expected always_on=True after merge')
        os.environ.pop('AGENT_HOOK_PROFILE', None)
        hermit_start.write_settings_env(config)
        self.assertEqual(os.environ.get('AGENT_HOOK_PROFILE'), 'standard')
        settings = self._read_settings()
        self.assertNotIn('AGENT_HOOK_PROFILE', settings.get('env', {}))

    def test_always_on_strict_not_downgraded(self):
        """always_on doesn't downgrade strict to standard (floor, not ceiling)."""
        self._write_config({
            'always_on': True,
            'env': {'AGENT_HOOK_PROFILE': 'strict'},
        })
        config = hermit_start.load_config()
        self.assertTrue(config.get('always_on'), 'Expected always_on=True after merge')
        os.environ.pop('AGENT_HOOK_PROFILE', None)
        hermit_start.write_settings_env(config)
        self.assertEqual(os.environ.get('AGENT_HOOK_PROFILE'), 'strict')
        settings = self._read_settings()
        self.assertNotIn('AGENT_HOOK_PROFILE', settings.get('env', {}))

    def test_existing_settings_preserved(self):
        """Pre-existing keys in settings.local.json survive write."""
        self._write_settings({'env': {'CUSTOM_VAR': 'keep-me'}, 'other_key': 'also-keep'})
        self._write_config({})
        config = hermit_start.load_config()
        hermit_start.write_settings_env(config)
        settings = self._read_settings()
        self.assertEqual(settings['env']['CUSTOM_VAR'], 'keep-me')
        self.assertEqual(settings['other_key'], 'also-keep')

    def test_profile_migration_removed_from_settings(self):
        """AGENT_HOOK_PROFILE is removed from settings.local.json (migration)."""
        self._write_settings({'env': {'AGENT_HOOK_PROFILE': 'strict', 'OTHER': 'keep'}})
        self._write_config({})
        config = hermit_start.load_config()
        os.environ.pop('AGENT_HOOK_PROFILE', None)
        hermit_start.write_settings_env(config)
        settings = self._read_settings()
        self.assertNotIn('AGENT_HOOK_PROFILE', settings['env'])
        self.assertEqual(settings['env']['OTHER'], 'keep')


# ============================================================
# Hook output tests
# ============================================================

class TestHookOutputs(_TempDirTest):

    def _run_hook(self, script, stdin_data='', env_extra=None):
        """Run a hook script and return (stdout, stderr, returncode)."""
        env = os.environ.copy()
        env['CLAUDE_PLUGIN_ROOT'] = str(REPO)
        if env_extra:
            env.update(env_extra)
        result = subprocess.run(
            ['node', str(REPO / 'scripts' / script)],
            input=stdin_data, capture_output=True, text=True,
            cwd=self._tmpdir, env=env, timeout=15,
        )
        return result.stdout, result.stderr, result.returncode

    def test_cost_tracker_fields(self):
        """cost-log.jsonl entry has required keys with correct types."""
        transcript = Path(self._tmpdir) / '.claude' / 'transcript.jsonl'
        os.makedirs(transcript.parent, exist_ok=True)
        shutil.copy(FIXTURES / 'transcript.jsonl', transcript)

        fixture = json.loads((FIXTURES / 'stop-hook-input.json').read_text())
        hook_input = json.dumps({
            **fixture,
            'transcript_path': str(transcript),
            'cwd': self._tmpdir,
        })

        stdout, stderr, code = self._run_hook('cost-tracker.js', hook_input)
        self.assertEqual(code, 0)

        log_path = Path(self._tmpdir) / '.claude' / 'cost-log.jsonl'
        self.assertTrue(log_path.exists(), 'cost-log.jsonl not created')

        entry = json.loads(log_path.read_text().strip().split('\n')[0])
        self.assertIsInstance(entry['session_id'], str)
        self.assertIsInstance(entry['estimated_cost_usd'], (int, float))
        self.assertIsInstance(entry['timestamp'], str)
        self.assertGreater(entry['estimated_cost_usd'], 0)

    # evaluate-session.js was retired in v1.1.0 (PROP-031 archive-pipeline retirement).
    # Tests removed.


# ============================================================
# cache-edit-guard hook
# ============================================================

class TestCacheEditGuard(_TempDirTest):
    """cache-edit-guard.js — silent-breakage zone.

    Project-local marketplaces load from `source` at runtime; cache copies are
    stale. Editing a cache file works *until* the bridge restarts and the source
    is read instead. The guard must catch this.
    """

    SCRIPT = REPO / 'scripts' / 'cache-edit-guard.js'

    def _run_guard(self, event, env_extra=None):
        env = os.environ.copy()
        env['CLAUDE_PLUGIN_ROOT'] = str(REPO)
        if env_extra:
            env.update(env_extra)
        result = subprocess.run(
            ['node', str(self.SCRIPT)],
            input=json.dumps(event), capture_output=True, text=True,
            cwd=self._tmpdir, env=env, timeout=10,
        )
        return result.stdout, result.stderr, result.returncode

    def _seed_marketplace(self, plugin_source):
        """Write .claude-plugin/marketplace.json + create the plugin source dir."""
        os.makedirs('.claude-plugin', exist_ok=True)
        manifest = {
            'name': 'example-marketplace',
            'plugins': [{'name': 'sample-plugin', 'source': plugin_source}],
        }
        with open('.claude-plugin/marketplace.json', 'w') as f:
            json.dump(manifest, f)
        if isinstance(plugin_source, str):
            os.makedirs(plugin_source.lstrip('./'), exist_ok=True)

    def _cache_path(self, *parts):
        rel = os.path.join('.claude/plugins/cache/example-marketplace/sample-plugin/0.1.0', *parts)
        return os.path.join(self._tmpdir, rel)

    def test_cache_edit_warns_with_source_path(self):
        self._seed_marketplace('./services/sample-plugin')
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._cache_path('server.ts')},
        })
        self.assertEqual(code, 0)
        self.assertIn('WARNING', stderr)
        self.assertIn('marketplace cache copy', stderr)
        self.assertIn('services/sample-plugin/server.ts', stderr)

    def test_block_mode_exits_2(self):
        self._seed_marketplace('./services/sample-plugin')
        stdout, stderr, code = self._run_guard(
            {
                'tool_name': 'Write',
                'tool_input': {'file_path': self._cache_path('server.ts')},
            },
            env_extra={'HERMIT_CACHE_GUARD': 'block'},
        )
        self.assertEqual(code, 2)
        self.assertIn('BLOCKED', stderr)

    def test_remote_source_skipped(self):
        # Remote git refs are objects — guard must skip silently.
        self._seed_marketplace({'source': 'github', 'repo': 'someone/sample-plugin'})
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._cache_path('server.ts')},
        })
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')

    def test_non_cache_path_passes_through(self):
        self._seed_marketplace('./services/sample-plugin')
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Edit',
            'tool_input': {'file_path': os.path.join(self._tmpdir, 'README.md')},
        })
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')

    def test_non_edit_tool_passes_through(self):
        self._seed_marketplace('./services/sample-plugin')
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Read',
            'tool_input': {'file_path': self._cache_path('server.ts')},
        })
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')

    def test_no_marketplace_passes_through(self):
        # No .claude-plugin/marketplace.json → silent passthrough (foreign repo).
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._cache_path('server.ts')},
        })
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')

    def test_unknown_marketplace_passes_through(self):
        # Cache path names a marketplace not declared in this project's manifest.
        self._seed_marketplace('./services/sample-plugin')
        unknown_cache = os.path.join(
            self._tmpdir,
            '.claude/plugins/cache/some-other-marketplace/foo/0.1.0/index.js',
        )
        stdout, stderr, code = self._run_guard({
            'tool_name': 'Edit',
            'tool_input': {'file_path': unknown_cache},
        })
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')


# ============================================================
# Stderr sanitization tests
# ============================================================

class TestStderrSanitization(_TempDirTest):
    """Adversarial tool_input values must not produce raw control chars in hook stderr.

    Note: _seed_marketplace duplicates TestCacheEditGuard's helper with a
    simpler signature (fixed source). Kept duplicated rather than extracted
    to a mixin so each test class stays self-contained and failures are
    easier to read.
    """

    GUARD = REPO / 'scripts' / 'cache-edit-guard.js'
    CHANNEL = REPO / 'scripts' / 'channel-hook.js'

    def _run(self, script, event, env_extra=None):
        env = os.environ.copy()
        env['CLAUDE_PLUGIN_ROOT'] = str(REPO)
        if env_extra:
            env.update(env_extra)
        result = subprocess.run(
            ['node', str(script)],
            input=json.dumps(event), capture_output=True, text=True,
            cwd=self._tmpdir, env=env, timeout=10,
        )
        return result.stdout, result.stderr, result.returncode

    def _seed_marketplace(self):
        os.makedirs('.claude-plugin', exist_ok=True)
        manifest = {
            'name': 'example-marketplace',
            'plugins': [{'name': 'sample-plugin', 'source': './services/sample-plugin'}],
        }
        with open('.claude-plugin/marketplace.json', 'w') as f:
            json.dump(manifest, f)
        os.makedirs('services/sample-plugin', exist_ok=True)

    def _evil_cache_path(self, version, leaf='server.ts'):
        # Inject adversarial chars into the version segment ([^/]+ matches \n
        # and ESC), not the leaf ((.*)$ stops at \n and the regex fails).
        return os.path.join(
            self._tmpdir,
            '.claude/plugins/cache/example-marketplace/sample-plugin',
            version,
            leaf,
        )

    def test_cache_guard_strips_newline_in_path(self):
        self._seed_marketplace()
        _, stderr, _ = self._run(self.GUARD, {
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._evil_cache_path('0.1.0\nBAD')},
        })
        self.assertIn('WARNING', stderr)
        self.assertNotIn('\nBAD', stderr)
        self.assertIn('0.1.0?BAD', stderr)

    def test_cache_guard_strips_ansi_in_path(self):
        # ANSI in the leaf exercises BOTH safe(filePath) and safe(canonical):
        # canonical = path.join(sourceRoot, leaf), so a poisoned leaf taints
        # canonical too. The leaf regex `(.*)$` accepts \x1b (not a line
        # terminator), so the warning path still runs.
        self._seed_marketplace()
        _, stderr, _ = self._run(self.GUARD, {
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._evil_cache_path('0.1.0', 'srv\x1b[32mOK\x1b[0m.ts')},
        })
        self.assertIn('WARNING', stderr)
        self.assertNotIn('\x1b', stderr)
        self.assertIn('OK', stderr)

    def test_cache_guard_strips_c1_csi(self):
        self._seed_marketplace()
        _, stderr, _ = self._run(self.GUARD, {
            'tool_name': 'Edit',
            'tool_input': {'file_path': self._evil_cache_path('0.1.0\x9b32mFAKE\x9b0m')},
        })
        self.assertIn('WARNING', stderr)
        self.assertNotIn('\x9b', stderr)

    def test_channel_hook_strips_chat_id_controls(self):
        self._write_config({
            'channels': {'discord': {'enabled': True, 'dm_channel_id': None}},
        })
        _, stderr, _ = self._run(self.CHANNEL, {
            'tool_name': 'mcp__discord__reply',
            'tool_input': {'chat_id': 'abc\n\x1b[31mFAKE\x1b[0m'},
        })
        self.assertIn('saved discord.dm_channel_id', stderr)
        self.assertNotIn('\x1b', stderr)
        self.assertNotIn('\nFAKE', stderr)


# ============================================================
# Negative path tests
# ============================================================

class TestNegativePaths(_TempDirTest):

    def test_malformed_config(self):
        """Invalid JSON in config.json raises."""
        Path('.claude-code-hermit/config.json').write_text('{bad json')
        with self.assertRaises(json.JSONDecodeError):
            hermit_start.load_config()

    def test_channels_wrong_type(self):
        """Non-dict channels doesn't crash iter_channel_configs."""
        result = list(hermit_start.iter_channel_configs({'channels': 'string'}))
        self.assertEqual(result, [])


# ============================================================
# Cron corpus agreement tests
# ============================================================

class TestCronCorpus(unittest.TestCase):
    """validate-config.js validateCronSchedule() must accept the shared
    corpus of valid expressions and reject the invalid ones. Cron schedules
    are now consumed directly by CronCreate (via /hermit-routines), not parsed
    by hermit code — only config-time validation remains."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURES.parent / 'cron-test-corpus.json') as f:
            cls.corpus = json.load(f)

    def test_node_valid(self):
        """validate-config.js validateCronSchedule() accepts valid expressions."""
        exprs = json.dumps([c['schedule'] for c in self.corpus['valid_expressions']])
        js = f"""
        const v = require('{SCRIPTS}/validate-config.js');
        const exprs = {exprs};
        const fails = [];
        for (const e of exprs) {{
            const err = v.validateCronSchedule(e);
            if (err) fails.push(e + ': ' + err);
        }}
        if (fails.length) {{
            console.error(fails.join('\\n'));
            process.exit(1);
        }}
        """
        result = subprocess.run(
            ['node', '-e', js], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0,
                         f'Node rejected valid expressions:\n{result.stderr}')

    def test_node_invalid(self):
        """validate-config.js validateCronSchedule() rejects invalid expressions."""
        exprs = json.dumps([c['schedule'] for c in self.corpus['invalid_expressions']])
        js = f"""
        const v = require('{SCRIPTS}/validate-config.js');
        const exprs = {exprs};
        const fails = [];
        for (const e of exprs) {{
            const err = v.validateCronSchedule(e);
            if (!err) fails.push(e);
        }}
        if (fails.length) {{
            console.error('Expected rejection: ' + fails.join(', '));
            process.exit(1);
        }}
        """
        result = subprocess.run(
            ['node', '-e', js], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0,
                         f'Node accepted invalid expressions:\n{result.stderr}')


class TestMonitorsValidation(unittest.TestCase):
    """validate-config.js monitors block — error and warning paths."""

    # Minimal valid config to merge monitors into
    BASE_CONFIG = {
        "agent_name": None, "language": None, "timezone": None,
        "escalation": "balanced", "channels": {}, "env": {},
        "heartbeat": {"enabled": True, "active_hours": {"start": "08:00", "end": "23:00"}},
        "routines": [],
        "quality_gate": {"tier": "budget"},
    }

    def _run_validate(self, config_dict):
        """Call validate-config.js validate() via node -e; return {errors, warnings}."""
        config_json = json.dumps({**self.BASE_CONFIG, **config_dict})
        js = f"""
        const v = require('{SCRIPTS}/validate-config.js');
        const result = v.validate({config_json});
        process.stdout.write(JSON.stringify(result));
        """
        result = subprocess.run(
            ['node', '-e', js], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, f'node exited non-zero: {result.stderr}')
        return json.loads(result.stdout)

    def test_monitors_valid(self):
        """A fully valid monitor entry produces no errors or warnings."""
        out = self._run_validate({"monitors": [
            {"id": "cpu", "description": "CPU watch", "command": "top -bn1",
             "class": "poll", "timeout_ms": 5000, "persistent": False, "enabled": True}
        ]})
        self.assertEqual(out['errors'], [])
        self.assertEqual(out['warnings'], [])

    def test_monitors_not_array(self):
        """monitors must be an array — non-array value is an error."""
        out = self._run_validate({"monitors": "bad"})
        self.assertTrue(
            any('monitors: must be an array' in e for e in out['errors']),
            f'expected array error, got {out}',
        )

    def test_monitors_missing_id(self):
        """Monitor without id is an error."""
        out = self._run_validate({"monitors": [
            {"description": "no id here", "command": "true"}
        ]})
        self.assertTrue(
            any('missing or invalid id' in e for e in out['errors']),
            f'expected missing id error, got {out}',
        )

    def test_monitors_duplicate_id(self):
        """Two monitors sharing the same id produce a warning."""
        out = self._run_validate({"monitors": [
            {"id": "dup", "description": "first", "command": "true"},
            {"id": "dup", "description": "second", "command": "true"},
        ]})
        self.assertTrue(
            any('duplicate id' in w for w in out['warnings']),
            f'expected duplicate id warning, got {out}',
        )

    def test_monitors_invalid_class(self):
        """class value not in (stream, poll) is an error."""
        out = self._run_validate({"monitors": [
            {"id": "m1", "description": "desc", "command": "true", "class": "bad"}
        ]})
        self.assertTrue(
            any('class must be' in e for e in out['errors']),
            f'expected class error, got {out}',
        )

    def test_monitors_bad_timeout(self):
        """timeout_ms below 1000 is an error."""
        out = self._run_validate({"monitors": [
            {"id": "m1", "description": "desc", "command": "true", "timeout_ms": 500}
        ]})
        self.assertTrue(
            any('timeout_ms' in e for e in out['errors']),
            f'expected timeout_ms error, got {out}',
        )

    def test_monitors_missing_required_fields(self):
        """Monitor missing both description and command produces two errors."""
        out = self._run_validate({"monitors": [{"id": "m1"}]})
        desc_err = any('missing description' in e for e in out['errors'])
        cmd_err = any('missing command' in e for e in out['errors'])
        self.assertTrue(desc_err, f'expected missing description error, got {out}')
        self.assertTrue(cmd_err, f'expected missing command error, got {out}')


class TestProposalIdScheme(unittest.TestCase):
    """Contract tests for PROP-008 collision-safe proposal IDs.

    Guards against silent regressions: scripts narrowing the filename regex back
    to the legacy-only form, or session-mgr losing the full-ID capture pattern.
    """

    WIDENED_REGEX = r'/^PROP-\d+(?:-.+)?\.md$/'
    SESSION_MGR_REGEX = r'/PROP-[a-z0-9][a-z0-9-]*/gi'

    SCRIPTS_WITH_PROPOSAL_GLOB = [
        'reflect-precheck.js',
        'build-cortex.js',
        'cortex-refresh-stage.js',
        'weekly-review.js',
        'validate-frontmatter.js',
        'doctor-check.js',
    ]

    def test_scripts_use_widened_proposal_regex(self):
        """All six proposal-scanning scripts must contain the widened filename regex."""
        for script in self.SCRIPTS_WITH_PROPOSAL_GLOB:
            path = SCRIPTS / script
            self.assertTrue(path.exists(), f'{script} not found')
            content = path.read_text()
            self.assertIn(
                self.WIDENED_REGEX,
                content,
                f'{script} is missing the widened proposal regex — '
                f'new-format PROP-NNN-slug-HHMMSS.md files would be silently dropped',
            )

    # session-mgr.md was renamed to focus-mgr.md in v1.1.0 (PROP-031); the agent
    # no longer generates S-NNN reports, so the proposal-id capture regex retires.
    # Test removed.


if __name__ == '__main__':
    unittest.main()
