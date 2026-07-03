import path from 'path';
import os from 'os';
import { normalizeGateName } from '../config/gates';
import { getExecCommand, getWorkspaceRoot } from '../workspace';

// Helper to check if child path is inside parent
function checkPathInside(parent: string, child: string): boolean {
  const absParent = path.resolve(parent);
  const absChild = path.resolve(child);
  const relAbs = path.relative(absParent, absChild);
  return relAbs === '' || (!relAbs.startsWith('..') && !path.isAbsolute(relAbs));
}

export interface GateResult {
  gateName: 'runTests' | 'runLint';
  success: boolean;
  output: string;
  durationMs: number;
}

export async function runWithTimeout(cmd: string, timeoutMs: number = 30000, cwd?: string, externalSignal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  // Strict command allowlist validation to completely eliminate shell-injection risks from untrusted boundaries
  const isAllowedCommand = cmd === 'npm run test -- --watch=false' || cmd === 'npm run lint';
  if (!isAllowedCommand) {
    throw new Error(`Execution of unauthorized command is blocked: ${cmd}`);
  }

  if (cwd) {
    // 1. Strict pattern check: only allow safe alphanumeric and path separator characters to eliminate shell injection
    if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(cwd)) {
      throw new Error(`Security Exception: Directory path contains unsafe shell-characters: ${cwd}`);
    }

    // 2. Strict directory boundary check: must be inside workspace root or temp dir (tests)
    const runCwd = path.isAbsolute(cwd) ? cwd : path.join(getWorkspaceRoot(), cwd);
    const isCwdSafe = checkPathInside(getWorkspaceRoot(), runCwd) || 
                      (process.env.NODE_ENV === 'test' && checkPathInside(os.tmpdir(), runCwd));
    if (!isCwdSafe) {
      throw new Error(`Security Exception: Directory path is outside workspace root: ${cwd}`);
    }

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
    cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ${cmd}` : cmd,
    combinedSignal
  ).catch((err: any) => {
    if (timeoutSignal.aborted) {
      throw new Error(`Gate execution timed out after ${timeoutMs}ms`);
    }
    if (externalSignal?.aborted) {
      throw new Error(`Gate execution aborted by external signal`);
    }
    throw err;
  });

  if (result.exitCode !== 0) {
    const error: any = new Error(`Command failed: ${cmd}\n${result.stderr}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.exitCode;
    throw error;
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runTests(cwd: string = process.cwd(), abortSignal?: AbortSignal): Promise<GateResult> {
  const start = Date.now();
  try {
    const { stdout } = await runWithTimeout(`npm run test -- --watch=false`, 30000, cwd, abortSignal);
    return { gateName: 'runTests', success: true, output: stdout, durationMs: Date.now() - start };
  } catch (err: any) {
    return { gateName: 'runTests', success: false, output: err.stdout || err.message, durationMs: Date.now() - start };
  }
}

export async function runLint(cwd: string = process.cwd(), abortSignal?: AbortSignal): Promise<GateResult> {
  const start = Date.now();
  try {
    const { stdout } = await runWithTimeout(`npm run lint`, 30000, cwd, abortSignal);
    return { gateName: 'runLint', success: true, output: stdout, durationMs: Date.now() - start };
  } catch (err: any) {
    return { gateName: 'runLint', success: false, output: err.stdout || err.message, durationMs: Date.now() - start };
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
