import { getExecCommand, getWorkspaceRoot, resolveWorkDir } from './workspace';
import { buildExecOptions, parseExecToolArgs, truncateExecResult } from './execTool';
import { LogLevel } from '../orchestration/orchestrator/sessionState';


export function makeDockerToolHandler(
  secureWrite: (res: import("express").Response, data: string, isRequestClosed?: boolean) => Promise<void>,
  res: import("express").Response,
  abortSignal: AbortSignal,
  writeLog: (message: string, level?: LogLevel) => void,
  sessionId?: string,
  getAutoApproveAll?: () => boolean
) {
  return async (args: unknown) => {
    const parsed = parseExecToolArgs(args);
    const resolved = resolveWorkDir(parsed.workDir, getWorkspaceRoot());
    writeLog(`[run_terminal_docker] Running command: "${parsed.command}" inside ${resolved.ok ? resolved.dir : '(rejected: traversal)'}`, LogLevel.DEBUG);
    if (!resolved.ok) {
      return { stdout: '', stderr: resolved.error, exitCode: 1 };
    }
    const execCommand = getExecCommand();
    const result = await execCommand(parsed.command, abortSignal, buildExecOptions(parsed, resolved.dir));

    writeLog(`[run_terminal_docker] Completed with exit code ${result.exitCode}. Stdout length: ${result.stdout.length}, Stderr length: ${result.stderr.length}`, LogLevel.DEBUG);

    return truncateExecResult(result);
  };
}
