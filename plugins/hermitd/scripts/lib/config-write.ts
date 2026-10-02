import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../validate-config';
import { auditConfigChange } from './config-audit';

export function persistConfig({ hermitDir, before, after, actor, priorErrors }: {
  hermitDir: string;
  before: any;
  after: any;
  actor: string;
  priorErrors?: string[];
}): { newErrors: string[]; keptErrors: string[]; newWarnings: string[] } {
  const prior = before === undefined ? { errors: [], warnings: [] } : validate(before);
  const acceptedErrors = priorErrors ?? prior.errors;
  const report = validate(after);
  const result = {
    newErrors: report.errors.filter(e => !acceptedErrors.includes(e)),
    keptErrors: report.errors.filter(e => acceptedErrors.includes(e)),
    newWarnings: report.warnings.filter(w => !prior.warnings.includes(w)),
  };
  if (result.newErrors.length > 0) return result;
  const file = path.join(hermitDir, 'config.json');
  fs.mkdirSync(hermitDir, { recursive: true });
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  auditConfigChange(hermitDir, before, after, actor);
  return result;
}
