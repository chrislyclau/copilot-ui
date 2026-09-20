import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { CapiProxy } from './CapiProxy';
import { CopilotClient } from '../../src/agentCore/copilotSdk/boundary';

/**
 * Captures the builtin tool names the installed `@github/copilot-sdk` actually
 * declares to the model for a DEFAULT session -- i.e. the exact surface the
 * hand-maintained `builtins` allowlists (`src/agentCore/copilotSdk/builtinToolSets.ts`)
 * filter via `availableTools` (issue #478).
 *
 * Capture basis (fixed, so snapshot diffs stay meaningful across SDK bumps):
 * - a REAL SDK session (the npm-installed CLI runtime), created with NO
 *   `availableTools`/`excludedTools`/`tools` at all -- the SDK's own default,
 *   where every builtin the runtime materializes is live;
 * - the LLM completion boundary faked by `CapiProxy` (offline, no network --
 *   same harness as docs/copilot-sdk-record-replay.md), so this runs anywhere
 *   `npm test` runs, including CI;
 * - the tool names are read from the first `/chat/completions` request's
 *   `tools` array -- what the model is TOLD it may call, which is precisely
 *   what `availableTools` filters.
 *
 * NOT captured (deliberately): tools that only materialize under runtime
 * context a default offline session doesn't have (e.g. GitHub-auth-dependent
 * MCP tool materializations). The snapshot's basis is the default session;
 * if the SDK starts materializing more tools in that basis, the diff check
 * surfaces it.
 *
 * Consumers:
 * - `test/scripts/capture-builtin-tools.ts` -- manual, human-triggered
 *   snapshot regeneration (writes `test/snapshots/builtin-tools.json`).
 * - `test/agentCore/builtinToolsSnapshot.test.ts` -- the CI check that fails
 *   when the live set drifts from the checked-in snapshot.
 */
export interface BuiltinToolsSnapshot {
  /** Human-readable capture basis; kept in the file since JSON has no comments. */
  description: string;
  /** Version of the CLI/runtime process that materialized the tools (from `client.getStatus()`). */
  cliVersion: string;
  /** Sorted builtin tool wire names. */
  toolNames: string[];
}

export const BUILTIN_TOOLS_SNAPSHOT_PATH = path.resolve(process.cwd(), 'test/snapshots/builtin-tools.json');

const SNAPSHOT_DESCRIPTION =
  'Builtin tool names the installed @github/copilot-sdk declares to the model for a DEFAULT session ' +
  '(no availableTools/excludedTools/tools), captured offline via test/harness/builtinToolsCapture.ts ' +
  'against the CapiProxy harness. CI (test/agentCore/builtinToolsSnapshot.test.ts) diffs the live set ' +
  'against this file on every PR. On a diff, review each added/removed tool and decide explicitly: ' +
  'allow it by adding it to src/agentCore/copilotSdk/builtinToolSets.ts, or exclude it by omitting it ' +
  '(SYS-REQ-028a-1). Then refresh this file: npm run capture:builtin-tools (issue #478).';

/** npm package version of the installed SDK, as a fallback version marker. */
function installedSdkPackageVersion(): string {
  // The SDK's "exports" map blocks a direct './package.json' subpath require,
  // so resolve the real dist entry and walk up one level to the package root.
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@github/copilot-sdk');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), '../package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export async function captureBuiltinTools(): Promise<BuiltinToolsSnapshot> {
  const proxy = new CapiProxy();
  const proxyUrl = await proxy.start();
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-tools-capture-'));
  const snapshotPath = path.resolve(process.cwd(), 'test/snapshots/session_wrapper/create_resume.yaml');
  await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

  const client = new CopilotClient({
    workingDirectory: tmpWorkDir,
    logLevel: 'none',
    useLoggedInUser: false,
    env: {
      ...process.env,
      ...proxy.getProxyEnv(),
      COPILOT_API_URL: proxyUrl,
    },
  });

  await client.start();
  try {
    // Live CLI/runtime version -- the process whose Rust side owns the
    // builtin tool set, so it's the version marker a snapshot diff is
    // "about". Falls back to the npm package version if the RPC is
    // unavailable (they're versioned in lockstep via optionalDependencies).
    let cliVersion: string;
    try {
      cliVersion = (await client.getStatus()).version;
    } catch {
      cliVersion = installedSdkPackageVersion();
    }

    // NO availableTools/excludedTools/tools -- the SDK's default, every
    // materialized builtin live. (Passing `availableTools: []` would exclude
    // everything and capture an empty set.)
    const session = await client.createSession({
      model: 'claude-sonnet-4.5',
      provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' },
      autoApproveAll: false,
      onPermissionRequest: async () => ({ kind: 'reject', feedback: 'capture only' }),
    } as Parameters<typeof client.createSession>[0]);

    await session.sendAndWait('Hello', 30000);

    const firstWithTools = proxy.requestHistory.find(
      (r: { tools?: unknown }) => Array.isArray(r.tools) && r.tools.length > 0
    );
    if (!firstWithTools) {
      throw new Error(
        'captureBuiltinTools: no /chat/completions request carrying a tools array reached the proxy -- ' +
          'the SDK session may have failed before declaring its tool set.'
      );
    }
    const toolNames = ((firstWithTools.tools as Array<{ function?: { name?: string }; name?: string }>) ?? [])
      .map((t) => t.function?.name ?? t.name ?? '')
      .filter((name) => name.length > 0)
      .sort();

    return { description: SNAPSHOT_DESCRIPTION, cliVersion, toolNames };
  } finally {
    await client.stop();
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }
}

/** Reads the checked-in snapshot, or `undefined` if it doesn't exist yet. */
export function readBuiltinToolsSnapshot(): BuiltinToolsSnapshot | undefined {
  if (!fs.existsSync(BUILTIN_TOOLS_SNAPSHOT_PATH)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(BUILTIN_TOOLS_SNAPSHOT_PATH, 'utf8')) as BuiltinToolsSnapshot;
}

export function writeBuiltinToolsSnapshot(snapshot: BuiltinToolsSnapshot): void {
  fs.writeFileSync(BUILTIN_TOOLS_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}

/** Name-level diff between the live capture and the checked-in snapshot. */
export function diffToolNames(
  live: readonly string[],
  snapshot: readonly string[]
): { added: string[]; removed: string[] } {
  const snapshotSet = new Set(snapshot);
  const liveSet = new Set(live);
  return {
    added: live.filter((name) => !snapshotSet.has(name)),
    removed: snapshot.filter((name) => !liveSet.has(name)),
  };
}
