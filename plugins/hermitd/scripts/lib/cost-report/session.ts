// `cost-report.ts session <task_id>` reports cost attributed to one task record.
import { hermitDir } from '../cc-compat';
import { readTaskCostTotals } from '../task-report';
import { readTasks } from '../tasks';

export function run(argv: string[]): void {
  const root = hermitDir();
  const id = argv[0];
  const record = readTasks(root).find(row => row.id === id);
  const total = readTaskCostTotals(root, record ? [record] : [])[id];
  process.stdout.write(JSON.stringify({ cost_usd: Math.round((total?.cost ?? 0) * 10000) / 10000, tokens: total?.tokens ?? 0 }) + '\n');
}
