import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const skill = readFileSync(resolve(import.meta.dir, '../skills/ha-apply-change/SKILL.md'), 'utf8');

// This checks the executable runbook's ordering, not live model compliance.
// validate-apply writes to HA, so its numbered step must follow the preview.
test('HA apply instructions check policy and preview before the native approval invocation', () => {
  const steps = skill.split(/(?=^\d+\. \*\*)/m).filter(step => /^\d+\. \*\*/.test(step));
  const policy = steps.findIndex(step => step.includes('ha policy-check'));
  const approval = steps.findIndex(step => step.includes('**Preview**'));
  const write = steps.findIndex(step => step.includes('ha validate-apply'));

  expect(policy).toBeGreaterThanOrEqual(0);
  expect(approval).toBeGreaterThan(policy);
  expect(write).toBeGreaterThan(approval);
  expect(steps[approval]!).toContain('changed artifact or target requires a fresh preview');
});
