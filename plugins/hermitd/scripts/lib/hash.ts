// sha256 of a buffer or string, hex-encoded. Shared by the template-manifest
// pristine-baseline mechanism (evolve-plan classification, hatch seeding).

import crypto from 'node:crypto';

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
