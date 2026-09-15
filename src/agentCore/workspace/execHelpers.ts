import * as path from "node:path";

export type ExecResult = { stdout: string; stderr: string; exitCode: number | null };

/**
 * Options accepted by the runners' shared `execCommand` wrapper.
 *
 * `workDir` — directory the command should run in, relative to the workspace
 * root or absolute (must stay inside the workspace). The container mount
 * binds the workspace at the identical path, so the host-resolved absolute
 * path is also the container-side path.
 *
 * `timeoutMs` — per-call deadline. When given, it is composed with any
 * caller-provided AbortSignal; when absent, an existing caller signal keeps
 * owning the deadline (unchanged historical semantics) and only the
 * no-signal case falls back to the runner's default timeout.
 */
export interface ExecOptions {
  workDir?: string;
  timeoutMs?: number;
}

export const TRAVERSAL_ERROR =
  "Error: Directory path traversal detected. Access denied outside workspace boundaries.";

export type ResolvedWorkDir = { ok: true; dir: string } | { ok: false; error: string };

/**
 * Resolves a tool-supplied workingDir against the workspace root.
 * Relative paths resolve inside the root; absolute paths are accepted only
 * when they stay inside it — anything escaping the root (including paths
 * that merely *look* contained before normalization, e.g. via "..") is
 * rejected as traversal.
 */
export function resolveWorkDir(
  requested: string | undefined,
  workspaceRoot: string,
): ResolvedWorkDir {
  if (!requested || !requested.trim()) return { ok: true, dir: workspaceRoot };
  const absolute = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(workspaceRoot, requested);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (absolute !== workspaceRoot && !absolute.startsWith(rootWithSep)) {
    return { ok: false, error: TRAVERSAL_ERROR };
  }
  return { ok: true, dir: absolute };
}

/**
 * POSIX single-quote a path for safe embedding in the `cd` prefix written
 * into the shell's stdin. Belt-and-braces on top of resolveWorkDir: the
 * resolved dir is already normalized, but it may still contain characters
 * the shell would treat as operators.
 */
export function shellQuotePath(p: string): string {
  return `'` + p.replace(/'/g, `'\\''`) + `'`;
}

/**
 * Prepends a `cd` guard to the command stream so the shell starts in the
 * requested directory. Failing via `exit 91` gives a distinct, greppable
 * exit code for "workingDir does not exist" instead of an opaque OCI/spawn
 * error — and the bash diagnostic (`cd: x: No such file or directory`)
 * lands in stderr where the caller can act on it.
 */
export function prependWorkDir(command: string, dir: string, workspaceRoot: string): string {
  if (dir === workspaceRoot) return command;
  return `cd ${shellQuotePath(dir)} || exit 91\n${command}`;
}

/**
 * If the deadline signal we armed fired (TimeoutError reason — not a caller
 * abort), relabel the result so the caller can tell "timed out" apart from
 * "the command failed": exit code 124 (the GNU `timeout` convention) plus
 * an explicit stderr note. Only applies when the process never exited on
 * its own (exitCode null); a result that already carries a real exit code
 * wins.
 */
export function annotateTimeout(
  result: ExecResult,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): ExecResult {
  const reason = timeoutSignal.reason as { name?: string } | undefined;
  const timedOut = timeoutSignal.aborted && reason?.name === "TimeoutError" && result.exitCode === null;
  if (!timedOut) return result;
  const note = `[run_terminal_docker] Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`;
  return {
    ...result,
    exitCode: 124,
    stderr: result.stderr ? `${result.stderr}\n${note}` : note,
  };
}

/**
 * The deadline+workDir-aware wrapper both runners share. Keeps the
 * historical contract: a caller-provided signal alone is honored verbatim
 * (gates and other internal callers compose their own timeouts); an
 * explicit `opts.timeoutMs` is composed with it; no signal at all gets the
 * runner's default deadline, and a genuine timeout is annotated (exit 124).
 */
export async function execWithDefaults(
  run: (command: string, signal?: AbortSignal, workDir?: string) => Promise<ExecResult>,
  command: string,
  signal: AbortSignal | undefined,
  opts: ExecOptions | undefined,
  defaultTimeoutMs: number,
): Promise<ExecResult> {
  if (opts?.timeoutMs !== undefined) {
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const result = await run(command, effectiveSignal, opts?.workDir);
    return annotateTimeout(result, timeoutSignal, opts.timeoutMs);
  }
  if (signal) return run(command, signal, opts?.workDir);
  const timeoutSignal = AbortSignal.timeout(defaultTimeoutMs);
  const result = await run(command, timeoutSignal, opts?.workDir);
  return annotateTimeout(result, timeoutSignal, defaultTimeoutMs);
}
