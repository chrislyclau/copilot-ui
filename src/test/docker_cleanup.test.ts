import { assert, describe, it, vi, beforeEach } from "vitest";
import { runDockerProcess } from "../workspace/dockerRunner.js";
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
    assert.strictEqual(killCall[1][1], "test-container");
    assert.strictEqual(killCall[1][2], "bash");
    assert.strictEqual(killCall[1][3], "-c");
    assert.ok(
      killCall[1][4].includes('grep -sl "EXEC_RUN_ID=1234abcd-1234-1234-1234-123456789012" /proc/[0-9]*/environ'),
      "Expected kill command to grep for the RUN_ID"
    );
  });
});
