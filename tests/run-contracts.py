#!/usr/bin/env python3
"""Contract tests for claude-code-hermit.

Only add tests for silent breakage — not for every branch in every helper.
Tests cover: config template/runtime sync, boot merge logic, hook outputs, negative paths.

Usage: python3 tests/run-contracts.py [-v]
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
        'idle_behavior', 'idle_budget', 'routines', 'plugin_checks',
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

    def test_evaluate_session_standard(self):
        """Standard profile produces structured JSON with criteria."""
        stdout, stderr, code = self._run_hook(
            'evaluate-session.js', '{}',
            env_extra={'AGENT_HOOK_PROFILE': 'standard'},
        )
        self.assertEqual(code, 0)
        self.assertTrue(stdout.strip(), 'Expected JSON output from evaluate-session')
        data = json.loads(stdout)
        self.assertIn('criteria', data)
        self.assertIsInstance(data['criteria'], list)
        self.assertGreater(len(data['criteria']), 0)
        self.assertIn('overall', data)

    def test_evaluate_session_minimal(self):
        """Minimal profile produces no stdout (silence is the contract)."""
        stdout, stderr, code = self._run_hook(
            'evaluate-session.js', '{}',
            env_extra={'AGENT_HOOK_PROFILE': 'minimal'},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout.strip(), '')


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
    """Python cron-match.py and Node validate-config.js must agree on the
    shared test corpus for valid/invalid cron expressions."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURES.parent / 'cron-test-corpus.json') as f:
            cls.corpus = json.load(f)

    def test_python_valid_match(self):
        """cron-match.py returns exit 0 for valid expressions that should match."""
        for case in self.corpus['valid_expressions']:
            sched = case['schedule']
            for m in case.get('matches', []):
                if not m['expect']:
                    continue
                ts, dow = m['time'], str(m['dow'])
                result = subprocess.run(
                    ['python3', str(SCRIPTS / 'cron-match.py'), sched, ts, dow],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0,
                                 f'Expected match for {sched} at {ts} dow={dow}: {result.stderr}')

    def test_python_valid_no_match(self):
        """cron-match.py returns exit 1 for valid expressions that should not match."""
        for case in self.corpus['valid_expressions']:
            sched = case['schedule']
            for m in case.get('matches', []):
                if m['expect']:
                    continue
                ts, dow = m['time'], str(m['dow'])
                result = subprocess.run(
                    ['python3', str(SCRIPTS / 'cron-match.py'), sched, ts, dow],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 1,
                                 f'Expected no match for {sched} at {ts} dow={dow}')

    def test_python_invalid(self):
        """cron-match.py returns exit 2 for invalid expressions."""
        for case in self.corpus['invalid_expressions']:
            sched = case['schedule']
            result = subprocess.run(
                ['python3', str(SCRIPTS / 'cron-match.py'), sched],
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 2,
                             f'Expected exit 2 for invalid expression: {sched} (reason: {case.get("reason")})')

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


if __name__ == '__main__':
    unittest.main()
