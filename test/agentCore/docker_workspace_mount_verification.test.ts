import { assert, describe, expect, it, vi, beforeEach } from "vitest";

// dockerRunner caches CONTAINER_NAME / WORKSPACE_HOST_LOCATION / the mount
// verification result at module scope (mirroring the existing
// getContainerName() pattern), so each test that needs a fresh check must
// vi.resetModules() and re-import.
vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

describe("Docker workspace mount verification (#446)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.CONTAINER_NAME = "test-container";
    process.env.WORKSPACE_HOST_LOCATION = "/tmp/applet_workspace";
  });

  it("passes a bounded timeout to spawnSync so a wedged docker daemon can't hang the event loop", async () => {
    const cp = await import("child_process");
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, error: undefined } as any);
    vi.mocked(cp.spawn).mockReturnValue({
      pid: 1,
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn() },
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");
    void runDockerProcess("echo hi");
    await new Promise((r) => setTimeout(r, 10));

    const call = vi.mocked(cp.spawnSync).mock.calls[0]!;
    const options = call[2];
    assert.isNumber((options as any)?.timeout, "expected spawnSync to be called with a numeric timeout");
    assert.isAbove((options as any).timeout, 0);
  });

  it("reports a timed-out probe distinctly, not as a missing directory", async () => {
    const cp = await import("child_process");
    // spawnSync sets `signal` (and no `status`) when the child was killed
    // for exceeding the `timeout` option.
    vi.mocked(cp.spawnSync).mockReturnValue({ status: null, signal: "SIGKILL", error: undefined } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");

    await expect(runDockerProcess("echo hi")).rejects.toThrow(/Timed out.*verifying WORKSPACE_HOST_LOCATION/s);
    assert.strictEqual(vi.mocked(cp.spawn).mock.calls.length, 0);
  });

  it("attributes a dead/missing container to the container, not to a WORKSPACE_HOST_LOCATION mismatch", async () => {
    const cp = await import("child_process");
    // `docker exec` itself exits non-zero with a CLI-level stderr message
    // when the container isn't running -- `test` inside it never even ran.
    vi.mocked(cp.spawnSync).mockReturnValue({
      status: 1,
      error: undefined,
      stderr: 'Error response from daemon: Container "test-container" is not running',
    } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");

    await expect(runDockerProcess("echo hi")).rejects.toThrow(
      /docker exec failed before it could check the path/,
    );
    // Should not be misdiagnosed as a WORKSPACE_HOST_LOCATION mismatch.
    await expect(runDockerProcess("echo hi").catch((e) => e.message)).resolves.not.toMatch(
      /does not exist inside container/,
    );
  });

  it("rejects runDockerProcess with a clear error when the mounted path doesn't exist in the container", async () => {
    const cp = await import("child_process");
    // `docker exec <container> test -d <path>` exits non-zero when the
    // directory is absent — e.g. WORKSPACE_HOST_LOCATION drifted from the
    // path the container was actually started with.
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 1, error: undefined } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");

    await expect(runDockerProcess("echo hi")).rejects.toThrow(
      /does not exist inside container "test-container"/,
    );
    // Must never fall through to spawning the real command against a
    // container path we know is wrong.
    assert.strictEqual(vi.mocked(cp.spawn).mock.calls.length, 0);
  });

  it("proceeds to spawn the real command once the mount is confirmed", async () => {
    const cp = await import("child_process");
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, error: undefined } as any);
    vi.mocked(cp.spawn).mockReturnValue({
      pid: 1,
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn() },
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");
    void runDockerProcess("echo hi");
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(vi.mocked(cp.spawnSync).mock.calls.length, 1);
    assert.strictEqual(vi.mocked(cp.spawn).mock.calls.length, 1);
  });

  it("only verifies the mount once per process lifetime, not on every call", async () => {
    const cp = await import("child_process");
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, error: undefined } as any);
    vi.mocked(cp.spawn).mockReturnValue({
      pid: 1,
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { writable: true, write: vi.fn(), end: vi.fn() },
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any);

    const { runDockerProcess } = await import("../../src/agentCore/workspace/dockerRunner.js");
    void runDockerProcess("echo one");
    void runDockerProcess("echo two");
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(vi.mocked(cp.spawnSync).mock.calls.length, 1, "expected the docker exec test -d check to run only once");
    assert.strictEqual(vi.mocked(cp.spawn).mock.calls.length, 2);
  });
});
