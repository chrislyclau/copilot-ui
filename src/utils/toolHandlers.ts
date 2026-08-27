import { getExecCommand } from '../workspace';
import { LogLevel } from '../orchestrator/sessionState';


export function makeDockerToolHandler(
  secureWrite: (res: import("express").Response, data: string, isRequestClosed?: boolean) => Promise<void>,
  res: import("express").Response,
  abortSignal: AbortSignal,
  writeLog: (message: string, level?: LogLevel) => void,
  sensitiveValuesCache: Set<string> | null,
  sessionId?: string,
  getAutoApproveAll?: () => boolean
) {
  return async (args: unknown) => {
    writeLog(`[run_terminal_docker] Running command: "${((args as Record<string, unknown>).command as string)}" inside ${((args as Record<string, unknown>).workingDir as string) || '/workspace'}`, LogLevel.DEBUG);
    const execCommand = getExecCommand();
    const result = await execCommand(((args as Record<string, unknown>).command as string), abortSignal);

    writeLog(`[run_terminal_docker] Completed with exit code ${result.exitCode}. Stdout length: ${result.stdout.length}, Stderr length: ${result.stderr.length}`, LogLevel.DEBUG);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  };
}
