import { spawn } from "child_process";
import { killProcessGroup } from "./processGroup";

// Unlike nativeRunner's AI Studio mode — which mints an ephemeral mkdtemp
// scratch directory — desktop mode operates directly on a real host project
// checkout, so the root must be supplied explicitly rather than invented.
function getWorkspaceRootOrThrow(): string {
  const root = process.env.WORKSPACE_HOST_LOCATION;
  if (!root) {
    throw new Error(
      "WORKSPACE_HOST_LOCATION environment variable is not set. Desktop runner mode requires it to point at the host project directory."
    );
  }
  return root;
}

const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";

// Default timeout for user-supplied commands. Callers can override by passing
// their own AbortSignal; this deadline applies only when none is provided.
const EXEC_TIMEOUT_MS = 60_000;

/**
 * Executes a command natively on the desktop host, rooted at
 * WORKSPACE_HOST_LOCATION. Mirrors nativeRunner's runNativeProcess, but runs
 * against a real project checkout instead of an ephemeral scratch directory.
 */
export async function runDesktopProcess(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-s"], {
      cwd: getWorkspaceRootOrThrow(),
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
        // it was sent — mirrors the docker/native runners' wait-for-cleanup
        // behavior so callers get consistent "resolved means dead" semantics
        // across all three runners. Bounded by the same style of fallback
        // timer used elsewhere in this file in case close never fires.
        const timer = setTimeout(() => {
          child.removeAllListeners("close");
          resolve({ stdout: "", stderr: "Desktop process aborted", exitCode: 1 });
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve({ stdout: "", stderr: "Desktop process aborted", exitCode: 1 });
        });
        return;
      }
    }

    child.on("error", (err: any) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: "",
        stderr: `Failed to spawn desktop process: ${err.message}`,
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
          stderr: "Desktop process stdin not writable — timeout waiting for close.",
          exitCode: 1,
        });
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: "Desktop process stdin not writable — process failed to start.",
          exitCode: 1,
        });
      });
    }
  });
}

/**
 * Executes a command natively on the desktop host. Mirrors the execCommand
 * interface from dockerRunner.ts/nativeRunner.ts for use in desktop mode.
 *
 * If no AbortSignal is supplied, a default timeout of EXEC_TIMEOUT_MS is
 * applied to prevent LLM-generated commands from hanging indefinitely.
 */
export async function execCommand(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runDesktopProcess(command, signal ?? AbortSignal.timeout(EXEC_TIMEOUT_MS));
}

export function getWorkspaceRoot(): string {
  return getWorkspaceRootOrThrow();
}

export function getWorkspaceHostLocation(): string {
  return getWorkspaceRootOrThrow();
}

export function getGitDir(): string {
  return getWorkspaceRootOrThrow() + "/snapshots/.git";
}
