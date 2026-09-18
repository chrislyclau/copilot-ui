import { describe, it, expect, beforeAll } from 'vitest';
import {
  BUILTIN_TOOLS_SNAPSHOT_PATH,
  captureBuiltinTools,
  diffToolNames,
  readBuiltinToolsSnapshot,
  type BuiltinToolsSnapshot,
} from '../harness/builtinToolsCapture';
import {
  READONLY_AGENT_BUILTINS,
  STANDARD_AGENT_BUILTINS,
} from '../../src/agentCore/copilotSdk/builtinToolSets';

// CI diff check for the hand-maintained builtin tool allowlists (issue #478).
// The allowlists in src/agentCore/copilotSdk/builtinToolSets.ts are
// hand-maintained ON PURPOSE (a new SDK builtin is granted only by a
// deliberate human edit, never silently -- SYS-REQ-028a-1), which means an
// SDK bump that adds/renames/removes a builtin would otherwise go unnoticed.
// This suite closes that gap by asserting against what the LIVE SDK actually
// declares to the model (captured via test/harness/builtinToolsCapture.ts,
// same offline CapiProxy harness as sessionWrapper.integration.test.ts):
//
// 1. the live set must equal the checked-in snapshot
//    (test/snapshots/builtin-tools.json) -- any drift fails with a reviewable
//    +added/-removed diff, and the fix is always a human decision (allow via
//    builtinToolSets.ts, or exclude by omitting) followed by
//    `npm run capture:builtin-tools`;
// 2. the snapshot's cliVersion must match the live runtime -- so an SDK bump
//    is acknowledged even on a release where the tool names happen not to
//    change;
// 3. every name in the hand-maintained allowlists must be a real, currently
//    live builtin -- so an SDK rename/removal that would leave a dead name in
//    builtinToolSets.ts (silently disabling that tool for every session)
//    fails here instead of passing unnoticed.
//
// This is the same "assert against the live SDK, not an assumed contract"
// pattern as the FROZEN_SDK_SYSTEM_MESSAGE_BASELINE staleness guard in
// sessionWrapper.integration.test.ts (issue #345), applied to the tool set.
describe('Builtin tools snapshot vs the live SDK (issue #478)', () => {
  let live: BuiltinToolsSnapshot;
  let snapshot: BuiltinToolsSnapshot | undefined;

  beforeAll(async () => {
    [live, snapshot] = await Promise.all([captureBuiltinTools(), Promise.resolve(readBuiltinToolsSnapshot())]);
  }, 60000);

  it('has a checked-in snapshot to diff against', () => {
    expect(
      snapshot,
      `Missing ${BUILTIN_TOOLS_SNAPSHOT_PATH}. Run \`npm run capture:builtin-tools\` to establish the baseline, ` +
        'then review the tool list it captured before committing it.'
    ).toBeDefined();
  });

  it('live builtin tool set matches the checked-in snapshot', () => {
    expect(snapshot).toBeDefined();
    const { added, removed } = diffToolNames(live.toolNames, snapshot!.toolNames);

    const lines: string[] = [];
    if (added.length > 0) {
      lines.push(
        'NEW builtin tool(s) the installed SDK declares that the snapshot does not know about:',
        ...added.map((name) => `  + ${name}`)
      );
    }
    if (removed.length > 0) {
      lines.push(
        'Builtin tool(s) the installed SDK no longer declares:',
        ...removed.map((name) => `  - ${name}`)
      );
    }
    lines.push(
      '',
      'A human must decide explicitly for each changed tool (issue #478):',
      '  - allow it: add the wire name to src/agentCore/copilotSdk/builtinToolSets.ts',
      '    (remember view/grep/glob share permission kind "read" and must move together),',
      '  - or exclude it: omit it from that list (SYS-REQ-028a-1).',
      `Then refresh the snapshot: npm run capture:builtin-tools`
    );
    expect(added, lines.join('\n')).toEqual([]);
    expect(removed, lines.join('\n')).toEqual([]);
  });

  it('snapshot cliVersion matches the live runtime', () => {
    expect(snapshot).toBeDefined();
    expect(
      snapshot!.cliVersion,
      'The checked-in snapshot was captured against a different CLI/runtime version than the installed SDK ' +
        `(snapshot: ${snapshot!.cliVersion}, live: ${live.cliVersion}). Even if the tool names are identical, ` +
        're-verify the set and acknowledge the bump with: npm run capture:builtin-tools'
    ).toBe(live.cliVersion);
  });

  it('every hand-maintained allowlist entry is a real, currently-live builtin', () => {
    const liveSet = new Set(live.toolNames);
    for (const [label, list] of [
      ['STANDARD_AGENT_BUILTINS', STANDARD_AGENT_BUILTINS],
      ['READONLY_AGENT_BUILTINS', READONLY_AGENT_BUILTINS],
    ] as const) {
      const dead = list.filter((name) => !liveSet.has(name));
      expect(
        dead,
        `${label} contains name(s) the installed SDK no longer declares as builtins: ${dead.join(', ')}. ` +
          'The SDK likely renamed or removed them -- every session built from this list would silently lose ' +
          'those tools. Update src/agentCore/copilotSdk/builtinToolSets.ts (and re-run ' +
          'npm run capture:builtin-tools if the live set changed too).'
      ).toEqual([]);
    }
  });
});
