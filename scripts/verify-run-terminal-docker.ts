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
 * .github/workflows/docker-tool-verify.yml). This is NOT run as part of
 * `npm test`; ordinary CI has no container available (see issue #403
 * discussion) and this script fails fast rather than silently skipping if
 * one isn't.
 *
 * Because the workspace bind mount uses the identical path string on the
 * host and inside the container, listing that path alone doesn't prove much
 * -- it could look "correct" by coincidence. So this script also plants a
 * random canary file directly via a raw `docker exec` (bypassing all app
 * code) before the session starts, and checks that the actual
 * run_terminal_docker call -- driven end-to-end through the real handler --
 * can see it. That's non-coincidental, ground-truth evidence the command
 * ran inside this exact live container instance.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CapiProxy } from '../src/test/harness/CapiProxy';
import { CopilotClient, defineTool } from '../src/copilotSdk/boundary';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';
import { RUN_TERMINAL_DOCKER_TOOL } from '../src/config/tools';
import { getExecCommand, getWorkspaceHostLocation, getWorkspaceRoot } from '../src/workspace';

const execFileAsync = promisify(execFile);

const MARKER = 'VERIFY_RUN_TERMINAL_DOCKER_OK';
const SNAPSHOT_PATH = path.resolve(process.cwd(), 'src/test/snapshots/run_terminal_docker/verify_exec.yaml');
// Random per run so a stale/leftover file from a previous run (or a
// coincidentally similar-looking image filesystem) can't produce a false
// pass. Deliberately at container root (`/`), well outside the mounted
// workspace, so this doesn't overlap with anything the pwd/workspace-root
// check below is already covering.
const CANARY_FILENAME = `RUN_TERMINAL_DOCKER_CANARY_${randomUUID()}`;

function fail(message: string): never {
  console.error(`[verify-run-terminal-docker] FAIL: ${message}`);
  process.exit(1);
}

/**
 * Plants a canary file directly via the `docker` CLI -- completely outside
 * any app code path (no dockerRunner.ts, no getExecCommand()). This is the
 * independent "ground truth" write: if `run_terminal_docker` later sees this
 * file, that's real evidence the tool executed inside *this* container
 * instance, not just a coincidentally-matching path (see discussion on
 * issue #403 -- a bind mount with an identical host/container path string
 * means `ls <mounted path>` alone doesn't rule that out).
 */
async function plantCanary(containerName: string): Promise<void> {
  await execFileAsync('docker', ['exec', containerName, 'sh', '-c', `touch /${CANARY_FILENAME}`]);
}

async function removeCanary(containerName: string): Promise<void> {
  try {
    await execFileAsync('docker', ['exec', containerName, 'sh', '-c', `rm -f /${CANARY_FILENAME}`]);
  } catch {
    // best-effort cleanup; container teardown will remove it regardless
  }
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
  const containerName = process.env.CONTAINER_NAME;

  const expectedWorkspaceRoot = getWorkspaceRoot();

  await plantCanary(containerName);

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
    await removeCanary(containerName);
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

  if (!result.stdout.includes(CANARY_FILENAME)) {
    fail(
      `Canary file "${CANARY_FILENAME}" (planted via a raw \`docker exec\` before the session ` +
        `started, completely outside app code) was not visible to run_terminal_docker's \`ls /\`. ` +
        `This means the command executed by run_terminal_docker is NOT running inside the same ` +
        `live container instance this script planted the canary in -- a stronger, non-coincidental ` +
        `signal than a matching mount path alone. stdout was:\n${result.stdout}`
    );
  }

  console.log('[verify-run-terminal-docker] PASS: run_terminal_docker executed inside the real, live container.');
  console.log(`  workspace root: ${expectedWorkspaceRoot}`);
  console.log(`  canary file seen: ${CANARY_FILENAME}`);
  console.log(`  stdout:\n${result.stdout}`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
