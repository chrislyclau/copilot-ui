import { assert, describe, it, vi, beforeEach } from "vitest";
import { runDockerProcess } from "../workspace/dockerRunner";
import * as cp from "child_process";
import * as crypto from "crypto";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("crypto", () => ({
  randomUUID: vi.fn(),
}));

describe("Docker Cleanup & Orphan Handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CONTAINER_NAME = "test-container";
  });

  it("should spawn a container-side kill process on abort", async () => {
    const mockRunId = "1234abcd-1234-1234-1234-123456789012" as const;
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId);

    const mockChild: any = {
      pid: 9999,
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn() },
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(cp.spawn).mockReturnValue(mockChild);

    const ac = new AbortController();
    const p = runDockerProcess("sleep 100", ac.signal);

    // Give it a micro-tick to set up the spawn
    await new Promise((r) => setTimeout(r, 10));

    // Abort it
    ac.abort();

    // The first spawn should be the docker exec bash -s
    const calls = vi.mocked(cp.spawn).mock.calls;
    assert.ok(calls.length >= 2, "Expected at least 2 spawns (the run, and the kill)");

    const runCall = calls[0] as unknown as [string, string[], any];
    assert.strictEqual(runCall[0], "docker");
    assert.ok(runCall[1].includes("EXEC_RUN_ID=1234abcd-1234-1234-1234-123456789012"), "Expected run command to include RUN_ID env var");

    const killCall = calls[1] as any;
    assert.strictEqual(killCall[0], "docker");
    assert.strictEqual(killCall[1][1], "-e");
    assert.strictEqual(killCall[1][2], "EXEC_RUN_ID=1234abcd-1234-1234-1234-123456789012", "Expected kill exec to pass EXEC_RUN_ID via env var, not string interpolation");
    assert.strictEqual(killCall[1][3], "test-container");
    assert.strictEqual(killCall[1][4], "bash");
    assert.strictEqual(killCall[1][5], "-c");
    assert.ok(
      killCall[1][6].includes('grep -sl "EXEC_RUN_ID=$EXEC_RUN_ID" /proc/[0-9]*/environ'),
      "Expected kill command to grep for the RUN_ID via the shell's own EXEC_RUN_ID env var"
    );
  });

  // Creates a minimal EventEmitter-like mock child process so we can trigger
  // "close"/"error" from the test itself, rather than the fire-and-forget
  // vi.fn() stub used above (which is enough for asserting spawn args, but
  // can't exercise the promise-resolution paths that depend on those events).
  function createMockChild(pid: number) {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const child: any = {
      pid,
      kill: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        (listeners[event] ||= []).push(cb);
        return child;
      }),
      once: vi.fn((event: string, cb: (...args: any[]) => void) => {
        (listeners[event] ||= []).push(cb);
        return child;
      }),
      removeAllListeners: vi.fn((event?: string) => {
        if (event) delete listeners[event];
        else for (const k of Object.keys(listeners)) delete listeners[k];
        return child;
      }),
      emit(event: string, ...args: any[]) {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };
    return child;
  }

  it("still waits for container-side cleanup when the signal is already aborted before runDockerProcess is called", async () => {
    const mockRunId = "aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId as any);

    const mainChild = createMockChild(1111);
    const killProc = createMockChild(2222);
    let spawnCount = 0;
    vi.mocked(cp.spawn).mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1 ? mainChild : killProc;
    });

    const ac = new AbortController();
    ac.abort(); // aborted BEFORE runDockerProcess registers any listeners

    const p = runDockerProcess("sleep 100", ac.signal);

    // Give the synchronous kill + container-side spawn a tick to happen.
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(spawnCount, 2, "Expected the main spawn plus the container-side kill spawn even for an already-aborted signal");

    // The promise should not have resolved yet — it's waiting on the
    // container-side kill to close.
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(resolved, false, "Should not resolve before container-side cleanup completes");

    killProc.emit("close", 0);

    const result = await p;
    assert.strictEqual(result.stderr, "Docker process aborted");
    assert.strictEqual(result.exitCode, 1);
  });

  it("still resolves (via the grace timeout) if the container-side kill process fails to spawn", async () => {
    const mockRunId = "bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    vi.mocked(crypto.randomUUID).mockReturnValue(mockRunId as any);

    const mainChild = createMockChild(3333);
    const killProc = createMockChild(4444);
    let spawnCount = 0;
    vi.mocked(cp.spawn).mockImplementation(() => {
      spawnCount += 1;
      return spawnCount === 1 ? mainChild : killProc;
    });

    const ac = new AbortController();
    const p = runDockerProcess("sleep 100", ac.signal);
    await new Promise((r) => setTimeout(r, 10));

    ac.abort();
    await new Promise((r) => setTimeout(r, 10));

    // Simulate docker exec itself failing to spawn for the kill command.
    killProc.emit("error", new Error("ENOENT: docker not found"));

    // Host-side kill already happened synchronously; simulate the main
    // process's close firing as a result.
    mainChild.emit("close", null);

    const result = await p;
    assert.strictEqual(result.exitCode, null);
  });
});
