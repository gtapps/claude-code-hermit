// Detached verifier for a trusted /model or /effort command submitted by the Stop hook.
// Claude processes that command only after the hook returns, so confirmation cannot be
// observed synchronously inside stop-pipeline.ts.

import { HARNESS_CONFIRM_TIMEOUT_MS, isHarnessSwitchConfirmation, parseHarnessCommand } from './lib/harness-command';
import { capturePane, sendEnter, sendKeys, tmuxSessionAlive } from './lib/tmux';

const [sessionName, command, followUpText, ...extra] = process.argv.slice(2);
const followUp = followUpText === undefined ? null : parseHarnessCommand(followUpText);
if (!sessionName || (command !== '/model' && command !== '/effort') || extra.length > 0
  || (followUpText !== undefined && (command !== '/model' || followUp?.command !== '/effort'))) {
  process.exit(2);
}

const configuredTimeout = Number(process.env.HERMIT_HARNESS_CONFIRM_TIMEOUT_MS);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 250
  ? Math.min(configuredTimeout, HARNESS_CONFIRM_TIMEOUT_MS)
  : HARNESS_CONFIRM_TIMEOUT_MS;
async function confirmSwitch(command: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    const pane = capturePane(sessionName);
    if (pane === null) {
      if (!tmuxSessionAlive(sessionName)) process.exit(1);
      continue;
    }
    if (isHarnessSwitchConfirmation(command, pane)) {
      if (!sendEnter(sessionName)) process.exit(1);
      return;
    }
  }
  // A cached switch or zero-turn session can apply inline without a dialog.
}

await confirmSwitch(command);
if (followUpText !== undefined) {
  const dismissDeadline = Date.now() + 2000;
  let dismissed = false;
  while (Date.now() < dismissDeadline) {
    const pane = capturePane(sessionName);
    if (pane !== null && !isHarnessSwitchConfirmation('/model', pane)) { dismissed = true; break; }
    if (pane === null && !tmuxSessionAlive(sessionName)) process.exit(1);
    await Bun.sleep(100);
  }
  // Typing the follow-up while the model dialog is still up (or while the pane cannot be
  // read at all) would land the text in the modal and let its Enter answer whichever
  // option is selected. Dropping the effort leg is the safer of the two outcomes.
  if (!dismissed) process.exit(1);
  if (!sendKeys(sessionName, followUpText)) process.exit(1);
  await confirmSwitch('/effort');
}
process.exit(0);
