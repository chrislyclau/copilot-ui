import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getExecCommand, getWorkspaceRoot, resolveWorkDir } from '../../../src/agentCore/workspace';
import { makeAuditorExecToolHandler } from '../../../src/agentCore/auditorHelper';

// Under vitest the workspace module routes to the native runner
// (isAIStudio(): VITEST=true), so these tests exercise the real
// execWithDefaults/cd-guard path on the host with no docker needed. The
// docker runner uses the identical shared helpers (verified separately in
// execToolWorkingDir.docker.test.ts and against a live container by
// scripts/verify-run-terminal-docker.ts).

const ROOT = getWorkspaceRoot();
const execCommand = getExecCommand();

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'parity-sub'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'parity-sub', 'marker.txt'), 'inside-subdir');
});

describe('execCommand workingDir handling (native runner)', () => {
  it('runs the command in a relative workingDir resolved against the workspace root', async () => {
    const result = await execCommand('cat marker.txt', undefined, { workDir: 'parity-sub' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('inside-subdir');
  });

  it('accepts an absolute workingDir inside the workspace', async () => {
    const result = await execCommand('pwd', undefined, { workDir: path.join(ROOT, 'parity-sub') });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(ROOT, 'parity-sub'));
  });

  it('rejects traversal without spawning anything', async () => {
    const result = await execCommand('pwd', undefined, { workDir: '../../etc' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('path traversal');
    expect(result.stdout).toBe('');
  });

  it('reports a missing workingDir with a readable bash diagnostic (exit 91)', async () => {
    const resolved = resolveWorkDir('parity-sub/does-not-exist', ROOT);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const result = await execCommand('echo should-not-run', undefined, { workDir: resolved.dir });
    expect(result.exitCode).toBe(91);
    expect(result.stderr).toContain('No such file or directory');
    expect(result.stdout).not.toContain('should-not-run');
  });
});

describe('execCommand timeout handling (native runner)', () => {
  it('kills an over-long command and reports exit 124 with a timeout note', async () => {
    const started = Date.now();
    const result = await execCommand('sleep 10 && echo done', undefined, { timeoutMs: 1500 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(8000);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 2s');
    expect(result.stdout).not.toContain('done');
  });

  it('leaves a caller-provided signal as the sole deadline (no implicit default)', async () => {
    const result = await execCommand('sleep 0.2 && echo fine', AbortSignal.timeout(10_000));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('fine');
  });

  it('composes a caller signal with an explicit timeoutMs', async () => {
    const result = await execCommand('sleep 10 && echo done', AbortSignal.timeout(30_000), { timeoutMs: 1200 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 1s');
  });
});

describe('makeAuditorExecToolHandler deadline enforcement (PR #465 regression)', () => {
  // Reproduces the production call shape: gateLoop always passes a
  // session-scoped AbortController.signal that only fires on session
  // teardown, never on a timer (see gateLoop.ts:994, :1819). Before the
  // execTool.ts fix, an omitted timeoutSeconds left opts.timeoutMs
  // undefined, so execWithDefaults took the "signal alone, no deadline"
  // branch and a hanging command was never killed — contradicting the
  // tool schema's "commands are killed after 60s" promise. This uses an
  // explicit short timeoutSeconds (rather than waiting out the real 60s
  // default) to keep the test fast while proving the same composition
  // path: a long-lived non-timer signal must not suppress the deadline.
  it('still enforces a deadline when composed with a long-lived, non-timer session signal', async () => {
    const sessionAbort = new AbortController(); // never fires — models session lifetime
    const handler = makeAuditorExecToolHandler(sessionAbort.signal);

    const started = Date.now();
    // timeoutSeconds clamps to a 30s floor (MIN_TIMEOUT_SECONDS), so the
    // sleep must exceed that floor or it would complete before the
    // deadline and this test would pass for the wrong reason.
    const result = await handler({ command: 'sleep 40 && echo done', timeoutSeconds: 30 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(45_000);
    expect(result.exitCode).toBe(124);
    expect(String(result.stderr)).toContain('timed out');
    expect(String(result.stdout)).not.toContain('done');
  }, 50_000);
});

describe('makeAuditorExecToolHandler end-to-end (native runner)', () => {
  it('honors workingDir, timeoutSeconds, and truncation through the production handler', async () => {
    const handler = makeAuditorExecToolHandler();

    const wd = await handler({ command: 'cat marker.txt', workingDir: 'parity-sub' });
    expect(wd).toMatchObject({ stdout: 'inside-subdir', exitCode: 0 });

    const traversal = await handler({ command: 'pwd', workingDir: '/etc' });
    expect(traversal).toMatchObject({ exitCode: 1 });
    expect(String(traversal.stderr)).toContain('path traversal');

    const big = await handler({ command: 'seq 1 200000' });
    expect(String(big.stdout).length).toBeLessThanOrEqual(40_000 + 200);
    expect(String(big.stdout)).toContain('Output truncated');
    expect(String(big.stdout).endsWith('200000\n')).toBe(true);
  });
});
