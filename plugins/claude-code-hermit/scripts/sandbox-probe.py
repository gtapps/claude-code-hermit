#!/usr/bin/env python3
"""Sandbox capability probe for hermit.

Checks whether the Claude Code sandbox can run on this machine:
- macOS: PASS unconditionally (sandbox-exec is built in, no extra binaries needed)
- Linux/WSL2: checks bwrap + socat presence and user-namespace availability

Prints a single JSON object to stdout:
  {"status": "pass"|"warn"|"fail", "message": "...", "install_hint": "..."|null}

Always exits 0 — callers inspect .status, not the exit code.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def _detect_pkg_manager():
    """Return the install one-liner for bubblewrap+socat on this distro."""
    try:
        text = Path('/etc/os-release').read_text()
    except OSError:
        return 'install bubblewrap socat (check your package manager)'

    info = {}
    for line in text.splitlines():
        if '=' in line:
            k, _, v = line.partition('=')
            info[k.strip()] = v.strip().strip('"')

    distro_id = info.get('ID', '').lower()
    distro_like = info.get('ID_LIKE', '').lower()

    if 'debian' in distro_id or 'ubuntu' in distro_id or 'debian' in distro_like:
        return 'apt-get install -y bubblewrap socat'
    if 'fedora' in distro_id or 'rhel' in distro_id or 'centos' in distro_id or 'rhel' in distro_like:
        return 'dnf install -y bubblewrap socat'
    if 'arch' in distro_id:
        return 'pacman -S --noconfirm bubblewrap socat'
    if 'alpine' in distro_id:
        return 'apk add bubblewrap socat'
    return 'install bubblewrap socat (check your package manager)'


def _run_ok(cmd):
    """Return True if cmd exits 0 within 5 s."""
    try:
        return subprocess.run(cmd, capture_output=True, timeout=5).returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def probe():
    # macOS: sandbox-exec is built in.
    if platform.system() == 'Darwin':
        return {
            'status': 'pass',
            'message': 'macOS: sandbox-exec is built in, no extra binaries needed.',
            'install_hint': None,
        }

    # Linux / WSL2: check bwrap and socat.
    missing = [b for b in ('bwrap', 'socat') if not shutil.which(b)]
    if missing:
        return {
            'status': 'fail',
            'message': f'Missing: {", ".join(missing)}. Sandbox will silently degrade.',
            'install_hint': _detect_pkg_manager(),
        }

    # Check unprivileged user-namespace access (required by bwrap on most Linux kernels).
    if not _run_ok(['unshare', '--user', '--pid', 'true']):
        return {
            'status': 'warn',
            'message': (
                'bwrap and socat found, but unprivileged user-namespaces appear disabled. '
                'Sandbox may not start. '
                'On Ubuntu 24.04+ the cause is the AppArmor restriction on bwrap (install '
                'the bwrap AppArmor profile per the Claude Code sandbox docs). '
                'On older kernels the cause is `kernel.unprivileged_userns_clone=0` '
                '(enable with `sysctl -w kernel.unprivileged_userns_clone=1`).'
            ),
            'install_hint': (
                'Ubuntu 24.04+: install /etc/apparmor.d/bwrap (see '
                'https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2). '
                'Older kernels: sysctl -w kernel.unprivileged_userns_clone=1.'
            ),
        }

    return {
        'status': 'pass',
        'message': 'bwrap, socat, and user-namespaces OK.',
        'install_hint': None,
    }


if __name__ == '__main__':
    print(json.dumps(probe()))
    sys.exit(0)
