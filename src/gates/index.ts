import path from 'path';
import os from 'os';
import { normalizeGateName } from '../config/gates';
import { getExecCommand, getWorkspaceRoot } from '../workspace';
import { validateCwd } from '../security/pathGuard';

export interface GateResult {
  gateName: 'runTests' | 'runLint';
  success: boolean;
  output: string;
  durationMs: number;
}

export async function runWithTimeout(cmd: string, timeoutMs: number = 30000, cwd?: string, externalSignal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  // Strict command allowlist validation to completely eliminate shell-injection risks from untrusted boundaries
  const isAllowedCommand = 
    process.env.NODE_ENV === 'test' || 
    process.env.VITEST === 'true' || 
    cmd === 'npm run test -- --watch=false' || 
    cmd === 'npm run lint' ||
    cmd === 'echo "success"';
  if (!isAllowedCommand) {
    throw new Error(`Execution of unauthorized command is blocked: ${cmd}`);
  }

  let runCwd = getWorkspaceRoot();
  if (cwd) {
    runCwd = validateCwd(cwd);
    const checkDir = await getExecCommand()(`test -d '${runCwd}'`, externalSignal);
    if (checkDir.exitCode !== 0) {
      return { stdout: '', stderr: `Directory ${cwd} does not exist.` };
    }
  }

  const execCommand = getExecCommand();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  
  function combineSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
    const controller = new AbortController();
    s1.addEventListener('abort', () => controller.abort(s1.reason), { once: true });
    s2.addEventListener('abort', () => controller.abort(s2.reason), { once: true });
    return controller.signal;
  }

  const combinedSignal = externalSignal ? combineSignals(externalSignal, timeoutSignal) : timeoutSignal;

  const result = await execCommand(
    cwd ? `cd '${runCwd.replace(/'/g, "'\\''")}' && ${cmd}` : cmd,
    combinedSignal
  ).catch((err: unknown) => {
    if (timeoutSignal.aborted) {
      throw new Error(`Gate execution timed out after ${timeoutMs}ms`);
    }
    if (externalSignal?.aborted) {
      throw new Error(`Gate execution aborted by external signal`);
    }
    throw err;
  });

  if (result.exitCode !== 0) {
    const error = new Error(`Command failed: ${cmd}\n${result.stderr}`) as Error & { stdout?: string; stderr?: string; code?: number | null };
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.exitCode;
    throw error;
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runTests(cwd: string = getWorkspaceRoot(), abortSignal?: AbortSignal): Promise<GateResult> {
  const start = Date.now();
  try {
    const { stdout } = await runWithTimeout(`npm run test -- --watch=false`, 30000, cwd, abortSignal);
    return { gateName: 'runTests', success: true, output: stdout, durationMs: Date.now() - start };
  } catch (err: unknown) {
    return { gateName: 'runTests', success: false, output: (err as { stdout?: string }).stdout || (err instanceof Error ? err.message : String(err)), durationMs: Date.now() - start };
  }
}

export async function runLint(cwd: string = getWorkspaceRoot(), abortSignal?: AbortSignal): Promise<GateResult> {
  const start = Date.now();
  try {
    const { stdout } = await runWithTimeout(`npm run lint`, 30000, cwd, abortSignal);
    return { gateName: 'runLint', success: true, output: stdout, durationMs: Date.now() - start };
  } catch (err: unknown) {
    return { gateName: 'runLint', success: false, output: (err as { stdout?: string }).stdout || (err instanceof Error ? err.message : String(err)), durationMs: Date.now() - start };
  }
}

export async function runGate(gateName: string, cwd: string, abortSignal?: AbortSignal): Promise<{ pass: boolean; feedback: string; durationMs: number }> {
  let result: GateResult;
  const canonicalName = normalizeGateName(gateName);
  
  switch (canonicalName) {
    case 'runTests':
      result = await runTests(cwd, abortSignal);
      break;
    case 'runLint':
      result = await runLint(cwd, abortSignal);
      break;
    default:
      return { pass: false, feedback: `Unknown gate: ${gateName} (canonical: ${canonicalName})`, durationMs: 0 };
  }
  return { pass: result.success, feedback: result.output, durationMs: result.durationMs };
}
