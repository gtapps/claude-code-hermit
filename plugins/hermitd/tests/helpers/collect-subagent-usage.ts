// Helper: run collectSubagentUsage on a transcript passed as JSON via stdin.
// Usage: echo '{"lines":["...","..."],"billedIndex":3}' | bun collect-subagent-usage.ts
// Output: JSON array of subagent records on stdout.
import { collectSubagentUsage } from '../../scripts/cost-tracker';

const raw = await new Response(Bun.stdin.stream()).text();
const { lines, billedIndex } = JSON.parse(raw.trim());
const results = collectSubagentUsage(lines, billedIndex);
process.stdout.write(JSON.stringify(results) + '\n');
