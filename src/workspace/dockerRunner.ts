import { spawn } from "child_process";
import * as crypto from "crypto";
import { killProcessGroup } from "./processGroup";

const FIXED_WORKSPACE_ROOT = "/app";
const WORKSPACE_HOST_LOCATION = process.env.WORKSPACE_HOST_LOCATION || "/tmp/applet_workspace";
// Default timeout for user-supplied commands. Callers can override by passing
// their own AbortSignal; this deadline applies only when none is provided.
const EXEC_TIMEOUT_MS = 60_000;

/**
 * Assume container is already running and initialized. User of the app should have full control over the container lifecycle. This module only provides a way to run commands inside the container.
 */
let CONTAINER_NAME = "";

function getContainerName(): string {
  if (!CONTAINER_NAME) {
    CONTAINER_NAME = process.env.CONTAINER_NAME || "";
    if (!CONTAINER_NAME) {
      throw new Error(
        "CONTAINER_NAME environment variable is not set. Please ensure the container name is provided.",
      );
    }
  }
  return CONTAINER_NAME;
}

/**
 * Executes a command inside the persistent Docker container via `docker exec`.
 * The container is started once by initializeWorkspace and remains running
 * for the lifetime of the app instance. Mount points and container configuration
 * are owned by docker-compose; this function only handles process lifecycle and I/O.
 */
export async function runDockerProcess(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // Needs to run docker exec -i container_name bash -s <<< "command"
  // No need to sanitize. The container is already an isolated environment.
  return new Promise((resolve) => {
    const runId = crypto.randomUUID();
    const child = spawn("docker", [
      "exec",
      "-i",
      "-e",
      `EXEC_RUN_ID=${runId}`,
      "-w",
      FIXED_WORKSPACE_ROOT,
      getContainerName(),
      "bash",
      "-s",
    ], { detached: true });

    // How long we're willing to wait for the container-side kill to confirm
    // before giving up and resolving anyway. Container cleanup is best-effort;
    // this bounds that effort instead of leaving callers to wait forever if
    // the docker daemon is unresponsive, while still closing most of the
    // "resolved before the orphan was actually killed" race.
    const CONTAINER_KILL_GRACE_MS = 1500;

    let killInitiated = false;
    let containerCleanupPromise: Promise<void> = Promise.resolve();

    // Kills the host-side docker exec process immediately (synchronous) and
    // returns a promise that resolves once the container-side cleanup has
    // either finished or timed out. Idempotent: calling this more than once
    // (e.g. from onAbort and then the stdin-not-writable branch) only spawns
    // the container-side kill once.
    const killChild = (): Promise<void> => {
      if (killInitiated) return containerCleanupPromise;
      killInitiated = true;

      // 1. Kill host-side docker exec client process
      killProcessGroup(child);

      // 2. Kill descendants inside the container namespace.
      // EXEC_RUN_ID is passed via -e (an env var), not interpolated into the
      // shell string, so this is safe regardless of what runId looks like —
      // no reliance on it always being a shell-metacharacter-free UUID.
      containerCleanupPromise = new Promise<void>((resolveCleanup) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          resolveCleanup();
        };
        const graceTimer = setTimeout(settle, CONTAINER_KILL_GRACE_MS);

        try {
          // The `[ "$pid" = "$$" ] && continue` guard excludes this very
          // bash process from the kill list. Without it, this exec is
          // tagged with the same EXEC_RUN_ID as the target, so it matches
          // its own grep. /proc/[0-9]*/environ globs in lexicographic (not
          // numeric) order, so whenever the target's PID and this script's
          // PID straddle a power-of-10 boundary (e.g. target=999,
          // self=1000), "1000" sorts before "999" and this script would
          // SIGKILL itself before reaching the real target — silently
          // leaking the orphan. Excluding $$ removes that ordering
          // dependency entirely.
          const killCmd = `for pid in $(grep -sl "EXEC_RUN_ID=$EXEC_RUN_ID" /proc/[0-9]*/environ | cut -d/ -f3); do [ "$pid" = "$$" ] && continue; kill -9 "$pid" || echo "kill-failed pid=$pid" >&2; done`;
          const killProc = spawn("docker", [
            "exec",
            "-e",
            `EXEC_RUN_ID=${runId}`,
            getContainerName(),
            "bash",
            "-c",
            killCmd,
          ]);

          // Best-effort cleanup, but we surface failures instead of silently
          // swallowing them, since a failed container-side kill means an
          // orphan process may still be running inside the container.
          let killStderr = "";
          killProc.stderr?.on("data", (data) => {
            killStderr += data.toString();
          });
          killProc.on("error", (err) => {
            console.warn(
              `Container-side kill for EXEC_RUN_ID=${runId} failed to spawn:`,
              err,
            );
            settle();
          });
          killProc.on("close", (code) => {
            if (code !== 0) {
              console.warn(
                `Container-side kill for EXEC_RUN_ID=${runId} exited with code ${code}` +
                  (killStderr ? `: ${killStderr.trim()}` : " (possible permission issue or no matching processes)"),
              );
            }
            settle();
          });
        } catch (e) {
          console.warn("Failed to spawn container-side kill process", e);
          settle();
        }
      });

      return containerCleanupPromise;
    };

    const onAbort = () => {
      void killChild();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        void killChild().then(() => {
          resolve({ stdout: "", stderr: "Docker process aborted", exitCode: 1 });
        });
        return;
      }
    }

    child.on("error", (err: any) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: "",
        stderr: `Failed to spawn docker process: ${err.message}`,
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
      if (killInitiated) {
        void containerCleanupPromise.then(() => {
          resolve({ stdout, stderr, exitCode: code });
        });
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });
    if (child.stdin.writable) {
      child.stdin.write(command + "\n");
      child.stdin.end();
    } else {
      if (signal) signal.removeEventListener("abort", onAbort);

      // Wait for the process to fully exit before resolving. A fallback timer
      // guards against close never firing (e.g. the kill not propagating into
      // the container). Whichever branch wins cancels the other to ensure
      // resolve() is called exactly once and neither handler is left dangling.
      const timer = setTimeout(() => {
        child.removeAllListeners("close");
        resolve({
          stdout: "",
          stderr: "Docker process stdin not writable — timeout waiting for close.",
          exitCode: 1,
        });
      }, 1000);

      child.once("close", () => {
        clearTimeout(timer);
        void containerCleanupPromise.then(() => {
          resolve({
            stdout: "",
            stderr: "Docker process stdin not writable — container may not be running.",
            exitCode: 1,
          });
        });
      });

      void killChild();
    }
  });
}

/**
 * Executes a command in /app.
 *
 * If no AbortSignal is supplied, a default timeout of EXEC_TIMEOUT_MS is
 * applied to prevent LLM-generated commands from hanging indefinitely.
 */
export async function execCommand(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runDockerProcess(command, signal ?? AbortSignal.timeout(EXEC_TIMEOUT_MS));
}
export function getWorkspaceRoot(): string {
  return FIXED_WORKSPACE_ROOT;
}
export function getWorkspaceHostLocation(): string {
  return WORKSPACE_HOST_LOCATION;
}
export function getGitDir(): string {
  return FIXED_WORKSPACE_ROOT + "/snapshots/.git";
}
