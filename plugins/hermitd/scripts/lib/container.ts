// Container detection, shared by the booter and doctor so neither has to import
// the other.

import fs from 'node:fs';

/** Detect if running inside a container (Docker, Podman, LXC). */
export function isContainer(): boolean {
  return (
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    process.env.container === 'docker'
  );
}
