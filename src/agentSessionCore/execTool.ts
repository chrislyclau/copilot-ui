import { Tool } from '../copilotSdk/boundary';
import { RUN_TERMINAL_DOCKER_TOOL } from '../config/tools';
import { getExecCommand } from '../workspace';
import { sanitizeSensitives } from '../utils/sanitizers';
import { truncateOutput } from '../utils/formatters';

export interface ExecToolResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface ExecToolStreamEvent {
  readonly toolName: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * SYS-REQ-029h: output delivery is orthogonal to the lock decision. A
 * consumer that wants results forwarded to an external stream (e.g. an SSE
 * response) supplies `onDeliver`; a consumer that doesn't want streaming
 * simply omits it. Neither choice touches the traversal-check/sanitization
 * logic below (SYS-REQ-029d), and neither reads orchestration-session state
 * (SYS-REQ-029e) -- that decision is made one layer up, by whether
 * `SessionWrapper.onPermissionRequest` lets the call through at all.
 */
export interface ExecToolHandlerOptions {
  readonly abortSignal?: AbortSignal;
  readonly sensitiveValuesCache?: Set<string> | null;
  readonly onDeliver?: (event: ExecToolStreamEvent) => Promise<void> | void;
  readonly writeLog?: (message: string) => void;
}

/**
 * SYS-REQ-029d: the single implementation of the shell-exec tool's
 * working-directory traversal check and output sanitization, shared by
 * every caller regardless of lock policy or delivery mode. This function
 * intentionally does NOT consult orchestration-session state (SYS-REQ-029e)
 * -- availability is decided entirely by whether `SessionWrapper` invokes
 * this handler in the first place.
 */
export function createExecToolHandler(options: ExecToolHandlerOptions = {}) {
  const { abortSignal, sensitiveValuesCache, onDeliver, writeLog } = options;

  return async (args: unknown): Promise<ExecToolResult> => {
    const record = (args as Record<string, unknown>) ?? {};
    const command = (record.command as string) || '';
    const workingDir = (record.workingDir as string) || '';

    if (workingDir.includes('..')) {
      writeLog?.(`[run_terminal_docker] Traversal path attempt blocked: ${workingDir}`);
      return {
        stdout: '',
        stderr: 'Error: Directory path traversal detected. Access denied outside workspace boundaries.',
        exitCode: 1,
      };
    }

    const execCommand = getExecCommand();
    const result = await execCommand(command, abortSignal);

    const stdout = truncateOutput(sanitizeSensitives(result.stdout, sensitiveValuesCache || new Set<string>()));
    const stderr = truncateOutput(sanitizeSensitives(result.stderr, sensitiveValuesCache || new Set<string>()));

    if (onDeliver) {
      await onDeliver({
        toolName: RUN_TERMINAL_DOCKER_TOOL.function.name,
        stdout,
        stderr,
        exitCode: result.exitCode,
      });
    }

    return { stdout, stderr, exitCode: result.exitCode };
  };
}

/**
 * SYS-REQ-029b: the single factory for the containerized shell-exec tool
 * definition, replacing the three independent `RUN_TERMINAL_DOCKER_TOOL.
 * function.*` -> `Tool` mappings this issue was opened to consolidate.
 * Schema values are sourced once, here, from `RUN_TERMINAL_DOCKER_TOOL` so
 * the wire contract itself still has a single source of truth.
 */
export function createExecTool(options: ExecToolHandlerOptions = {}): Tool {
  return {
    name: RUN_TERMINAL_DOCKER_TOOL.function.name,
    description: RUN_TERMINAL_DOCKER_TOOL.function.description,
    parameters: RUN_TERMINAL_DOCKER_TOOL.function.parameters,
    handler: createExecToolHandler(options),
  };
}
