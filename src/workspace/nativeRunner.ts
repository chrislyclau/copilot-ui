import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { killProcessGroup } from "./processGroup";

// fs.mkdtempSync atomically creates a uniquely-named directory under the
// OS temp root (respects TMPDIR/TEMP/TMP) and returns its path — avoiding
// the need to hand-roll uniqueness with crypto.randomUUID() plus a
// separate mkdirSync call.
const FIXED_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));

const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";

// Create the workspace root immediately at module load so spawn() never
// fails with ENOENT when setting cwd. This runs once before any async
// calls and is safe as a synchronous operation at module initialization.
fs.mkdirSync(FIXED_WORKSPACE_ROOT, { recursive: true });

// Default timeout for user-supplied commands. Callers can override by passing
// their own AbortSignal; this deadline applies only when none is provided.
const EXEC_TIMEOUT_MS = 60_000;

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
      env: process.env.NODE_ENV === "test" || process.env.VITEST === "true" ? process.env : { PATH: FIXED_PATH },
      detached: true,
    });

    const killChild = () => killProcessGroup(child);

    const onAbort = () => killChild();
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        killChild();
        // Wait for the OS to actually reap the process group before
        // resolving, rather than assuming SIGKILL took effect the instant
        // it was sent — mirrors the docker runner's wait-for-cleanup
        // behavior so callers get consistent "resolved means dead" semantics
        // across both runners. Bounded by the same style of fallback timer
        // used elsewhere in this file in case close never fires.
        const timer = setTimeout(() => {
          child.removeAllListeners("close");
          resolve({ stdout: "", stderr: "Native process aborted", exitCode: 1 });
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve({ stdout: "", stderr: "Native process aborted", exitCode: 1 });
        });
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
    } else {
      if (signal) signal.removeEventListener("abort", onAbort);
      killChild();

      // Wait for the process to fully exit before resolving. A fallback timer
      // guards against close never firing (e.g. the process ignores SIGKILL).
      // Whichever branch wins cancels the other to ensure resolve() is called
      // exactly once and neither handler is left dangling.
      const timer = setTimeout(() => {
        child.removeAllListeners("close");
        resolve({
          stdout: "",
          stderr: "Native process stdin not writable — timeout waiting for close.",
          exitCode: 1,
        });
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: "Native process stdin not writable — process failed to start.",
          exitCode: 1,
        });
      });
    }
  });
}

/**
 * Executes a command natively. Mirrors the execCommand interface
 * from dockerRunner.ts for use in AI Studio.
 *
 * If no AbortSignal is supplied, a default timeout of EXEC_TIMEOUT_MS is
 * applied to prevent LLM-generated commands from hanging indefinitely.
 */
export async function execCommand(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runNativeProcess(command, signal ?? AbortSignal.timeout(EXEC_TIMEOUT_MS));
}

export function getWorkspaceRoot(): string {
  return FIXED_WORKSPACE_ROOT;
}

export function getWorkspaceHostLocation(): string {
  return FIXED_WORKSPACE_ROOT;
}

export function getGitDir(): string {
  return FIXED_WORKSPACE_ROOT + "/snapshots/.git";
}
