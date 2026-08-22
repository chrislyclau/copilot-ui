/**
 * Verifies `run_terminal_docker` works end-to-end against a REAL container
 * (issue #403). Nothing about the tool-execution path is mocked: this drives
 * the actual production handler (`makeAuditorExecToolHandler` ->
 * `getExecCommand()` -> `dockerRunner.ts` -> real `docker exec`) through a
 * real `CopilotClient`/`SessionWrapper` session. The ONLY faked boundary is
 * the LLM completion itself (via `CapiProxy`, replaying
 * `src/test/snapshots/run_terminal_docker/verify_exec.yaml`) -- see
 * copilot-sdk-record-replay.md. There is no vitest gate-loop/retry logic in
 * this path to silently absorb a failed `docker exec`; a broken container
 * mount fails this script loudly and exits non-zero.
 *
 * Requires a real running container (CONTAINER_NAME + WORKSPACE_HOST_LOCATION
 * set consistently, matching the actual `docker compose up` mount -- see
 * workflow-hotswap/docker-tool-verify.yml). This is NOT run as part of
 * `npm test`; ordinary CI has no container available (see issue #403
 * discussion) and this script fails fast rather than silently skipping if
 * one isn't.
 */
import * as path from 'node:path';
import { CapiProxy } from '../src/test/harness/CapiProxy';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { RUN_TERMINAL_DOCKER_TOOL } from '../src/config/tools';
import { getExecCommand, getWorkspaceHostLocation, getWorkspaceRoot } from '../src/workspace';

const MARKER = 'VERIFY_RUN_TERMINAL_DOCKER_OK';
const SNAPSHOT_PATH = path.resolve(process.cwd(), 'src/test/snapshots/run_terminal_docker/verify_exec.yaml');

function fail(message: string): never {
  console.error(`[verify-run-terminal-docker] FAIL: ${message}`);
  process.exit(1);
}

/**
 * The exact production handler, minus only the abortSignal wiring (this
 * script has no request-scoped signal to thread through). Deliberately NOT
 * reimplemented -- if this handler's contract or dockerRunner routing ever
 * changes, this check should change with it rather than drift from what
 * production actually calls.
 */
function makeExecToolHandler() {
  return async (args: unknown) => {
    const record = args as Record<string, unknown>;
    const execCommand = getExecCommand();
    const result = await execCommand((record.command as string) || '');
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };
}

async function main(): Promise<void> {
  if (!process.env.CONTAINER_NAME) {
    fail('CONTAINER_NAME is not set -- this script requires a real running container, not a mocked one.');
  }

  const expectedWorkspaceRoot = getWorkspaceRoot();

  let capturedResult: { stdout: string; stderr: string; exitCode: number | null } | null = null;

  const proxy = new CapiProxy();
  const proxyUrl = await proxy.start();
  await proxy.updateConfig({ filePath: SNAPSHOT_PATH, workDir: process.cwd() });

  const client = new CopilotClient({
    workingDirectory: getWorkspaceHostLocation(),
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
    const innerHandler = makeExecToolHandler();
    const execTool = defineTool(
      RUN_TERMINAL_DOCKER_TOOL.function.name,
      RUN_TERMINAL_DOCKER_TOOL.function.description,
      RUN_TERMINAL_DOCKER_TOOL.function.parameters,
      async (args: unknown) => {
        const result = await innerHandler(args);
        capturedResult = result;
        return result;
      }
    );

    const wrapper = new SessionWrapper(
      client,
      { custom: [execTool] },
      { provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' } }
    ).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('Run the verification command.', 30000);
  } finally {
    await client.stop();
    await proxy.stop();
  }

  if (!capturedResult) {
    fail('run_terminal_docker was never invoked -- the scripted tool call did not reach the real handler.');
  }

  const result = capturedResult as { stdout: string; stderr: string; exitCode: number | null };

  if (result.exitCode !== 0) {
    fail(
      `docker exec exited with code ${result.exitCode}. stderr:\n${result.stderr}\n` +
        `This is exactly the class of failure reported in issue #403 (WORKSPACE_HOST_LOCATION ` +
        `mismatch causing OCI runtime exec failure) if stderr mentions a chdir/cwd error.`
    );
  }

  if (!result.stdout.includes(expectedWorkspaceRoot)) {
    fail(
      `docker exec ran in the wrong directory. Expected \`pwd\` output to contain the real ` +
        `workspace root (${expectedWorkspaceRoot}), got:\n${result.stdout}\n` +
        `This is the exact regression #403 describes: WORKSPACE_HOST_LOCATION as seen by this ` +
        `process doesn't match where docker-compose actually mounted the workspace.`
    );
  }

  if (!result.stdout.includes(MARKER)) {
    fail(`Expected marker "${MARKER}" not found in stdout:\n${result.stdout}`);
  }

  console.log('[verify-run-terminal-docker] PASS: run_terminal_docker executed in the correct real workspace root.');
  console.log(`  workspace root: ${expectedWorkspaceRoot}`);
  console.log(`  stdout:\n${result.stdout}`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
