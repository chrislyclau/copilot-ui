/**
 * Re-run this whenever @github/copilot-sdk is upgraded (or whenever
 * test/agentCore/builtinToolsSnapshot.test.ts fails) to refresh the checked-in
 * builtin-tools snapshot `test/snapshots/builtin-tools.json` (issue #478).
 *
 * The snapshot is the reviewable-diff anchor for the hand-maintained builtin
 * allowlists (`src/agentCore/copilotSdk/builtinToolSets.ts`): CI diffs the
 * live SDK's builtin tool set against this file on every PR, so a bump that
 * adds/renames/removes a builtin fails loudly instead of going unnoticed.
 * This script does NOT decide allow vs exclude for you -- after refreshing,
 * review the diff it prints and make the allow (edit builtinToolSets.ts) or
 * exclude (omit) decision for each changed tool yourself.
 *
 * Lives under test/scripts/ (rather than scripts/) and is deliberately named
 * without a `.test.ts` suffix, mirroring capture-system-message-baseline.ts:
 * it drives `CopilotClient.createSession` directly against a real (proxied)
 * SDK on purpose, and vitest must not pick it up as a suite -- it's a manual,
 * human-triggered capture, not a test.
 *
 * Usage: npm run capture:builtin-tools
 */
import {
  BUILTIN_TOOLS_SNAPSHOT_PATH,
  captureBuiltinTools,
  diffToolNames,
  readBuiltinToolsSnapshot,
  writeBuiltinToolsSnapshot,
} from '../harness/builtinToolsCapture';

async function main() {
  console.log('Capturing the live builtin tool set from the installed @github/copilot-sdk...');
  const live = await captureBuiltinTools();
  const previous = readBuiltinToolsSnapshot();

  writeBuiltinToolsSnapshot(live);
  console.log(`Wrote ${BUILTIN_TOOLS_SNAPSHOT_PATH}`);
  console.log(`  cliVersion: ${live.cliVersion}`);
  console.log(`  tool count: ${live.toolNames.length}`);

  if (previous) {
    const { added, removed } = diffToolNames(live.toolNames, previous.toolNames);
    if (previous.cliVersion !== live.cliVersion) {
      console.log(`\nCLI version changed: ${previous.cliVersion} -> ${live.cliVersion}`);
    }
    if (added.length === 0 && removed.length === 0) {
      console.log('\nTool names unchanged.');
    } else {
      console.log('\nTool-name diff vs the previous snapshot:');
      for (const name of added) {
        console.log(`  + ${name}  (NEW -- allow it in builtinToolSets.ts or leave it excluded, deliberately)`);
      }
      for (const name of removed) {
        console.log(`  - ${name}  (REMOVED by the SDK -- remove it from builtinToolSets.ts if listed there)`);
      }
      console.log(
        '\nReview each change and make the allow/exclude decision explicitly ' +
          '(src/agentCore/copilotSdk/builtinToolSets.ts) before committing the refreshed snapshot.'
      );
    }
  } else {
    console.log('\nNo previous snapshot existed -- this run establishes the baseline.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
