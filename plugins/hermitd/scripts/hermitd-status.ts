import { projectStatus, renderStatus } from './lib/hermit-status';
try {
  console.log(renderStatus([projectStatus(process.cwd())], process.argv.includes('--json')));
} catch (error) {
  console.error(`[hermit] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
