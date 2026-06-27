import { spawn } from "child_process";
import crypto from "crypto";
const FIXED_WORKSPACE_ROOT = "/tmp/app-" + crypto.randomUUID();
const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";
/**
 * Executes a command natively on the host (AI Studio mode).
 * Commands run inside the workspace root with only git-specific environment
 * variables set — no host environment is leaked.
 */
export async function runNativeProcess(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-s"], {
      cwd: getWorkspaceRoot(),
      env: { PATH: FIXED_PATH },
    });

    const onAbort = () => child.kill("SIGKILL");
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        child.kill("SIGKILL");
        resolve({ stdout: "", stderr: "Native process aborted", exitCode: 1 });
        return;
      }
    }

    child.on("error", (err: any) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: "",
        stderr: `Failed to spawn native process: ${err.message}`,
        exitCode: 127,
      });
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code });
    });

    if (child.stdin.writable) {
      child.stdin.write(command + "\n");
      child.stdin.end();
    }
  });
}

/**
 * Executes a command natively. Mirrors the execCommand interface
 * from dockerRunner.ts for use in AI Studio.
 */
export async function execCommand(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runNativeProcess(command, signal);
}

export function getWorkspaceRoot(): string {
  return FIXED_WORKSPACE_ROOT;
}
export function getGitDir(): string {
  return FIXED_WORKSPACE_ROOT + "/snapshots/.git";
}
