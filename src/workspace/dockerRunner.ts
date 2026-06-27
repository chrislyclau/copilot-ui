import { spawn } from "child_process";
const FIXED_WORKSPACE_ROOT = "/app";

/**
 * Assume container is already running and initialized. User of the app should have full control over the container lifecycle. This module only provides a way to run commands inside the container.
 */
let CONTAINER_NAME = "";

function getContainerName(): string {
  if (!CONTAINER_NAME) {
    CONTAINER_NAME = process.env.CONTAINER_NAME;
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
    const child = spawn("docker", [
      "exec",
      "-i",
      "-w",
      FIXED_WORKSPACE_ROOT,
      getContainerName(),
      "bash",
      "-s",
    ]);

    const onAbort = () => child.kill("SIGKILL");
    if (signal) {
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        child.kill("SIGKILL");
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
    }
  });
}

/**
 * Executes a command in /app
 */
export async function execCommand(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return runDockerProcess(command, signal);
}
export function getWorkspaceRoot(): string {
  return FIXED_WORKSPACE_ROOT;
}
export function getGitDir(): string {
  return FIXED_WORKSPACE_ROOT + "/snapshots/.git";
}
