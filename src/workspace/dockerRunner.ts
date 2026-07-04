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

    const killChild = () => {
      // 1. Kill host-side docker exec client process
      killProcessGroup(child);
      
      // 2. Kill descendants inside the container namespace.
      // runId is always a crypto.randomUUID() value (fixed hex/hyphen format,
      // no shell metacharacters), so it is safe to interpolate directly here.
      // If runId is ever sourced from elsewhere, it must be shell-escaped.
      try {
        const killCmd = `for pid in $(grep -sl "EXEC_RUN_ID=${runId}" /proc/[0-9]*/environ | cut -d/ -f3); do kill -9 "$pid" || echo "kill-failed pid=$pid" >&2; done`;
        const killProc = spawn("docker", [
          "exec",
          getContainerName(),
          "bash",
          "-c",
          killCmd,
        ]);

        // This is best-effort cleanup fired during abort/close handling, so we
        // don't block on it — but we do surface failures instead of silently
        // swallowing them, since a failed container-side kill means an orphan
        // process may still be running inside the container.
        let killStderr = "";
        killProc.stderr?.on("data", (data) => {
          killStderr += data.toString();
        });
        killProc.on("error", (err) => {
          console.warn(
            `Container-side kill for EXEC_RUN_ID=${runId} failed to spawn:`,
            err,
          );
        });
        killProc.on("close", (code) => {
          if (code !== 0) {
            console.warn(
              `Container-side kill for EXEC_RUN_ID=${runId} exited with code ${code}` +
                (killStderr ? `: ${killStderr.trim()}` : " (possible permission issue or no matching processes)"),
            );
          }
        });
      } catch (e) {
        console.warn("Failed to spawn container-side kill process", e);
      }
    };

    const onAbort = () => killChild();
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        killChild();
        resolve({ stdout: "", stderr: "Docker process aborted", exitCode: 1 });
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
      resolve({ stdout, stderr, exitCode: code });
    });
    if (child.stdin.writable) {
      child.stdin.write(command + "\n");
      child.stdin.end();
    } else {
      if (signal) signal.removeEventListener("abort", onAbort);
      killChild();

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
        resolve({
          stdout: "",
          stderr: "Docker process stdin not writable — container may not be running.",
          exitCode: 1,
        });
      });
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
