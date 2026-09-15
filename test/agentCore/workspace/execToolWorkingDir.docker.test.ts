import { assert, describe, it, vi, beforeEach } from "vitest";
import { execCommand, runDockerProcess } from "../../../src/agentCore/workspace/dockerRunner";
import * as cp from "child_process";
import * as crypto from "crypto";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, error: undefined })),
}));

vi.mock("crypto", () => ({
  randomUUID: vi.fn(),
}));

const WS_ROOT = "/workspace/applet_workspace";

function createMockChild(pid: number) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const stdinWrites: string[] = [];
  const child: any = {
    pid,
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: {
      writable: true,
      write: vi.fn((chunk: string) => {
        stdinWrites.push(chunk);
        return true;
      }),
      end: vi.fn(),
    },
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
    stdinWrites,
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
  };
  return child;
}

describe("docker runner workingDir handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CONTAINER_NAME = "test-container";
    process.env.WORKSPACE_HOST_LOCATION = WS_ROOT;
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, error: undefined } as never);
  });

  it("prepends a cd guard for a relative workingDir", async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue("cccc0000-cccc-cccc-cccc-cccccccccccc" as never);
    const mainChild = createMockChild(1111);
    vi.mocked(cp.spawn).mockReturnValue(mainChild);

    const p = runDockerProcess("ls -la", undefined, "docs");
    await new Promise((r) => setTimeout(r, 10));
    mainChild.emit("close", 0);
    const result = await p;

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(mainChild.stdinWrites.length, 1);
    assert.strictEqual(
      mainChild.stdinWrites[0],
      `cd '${WS_ROOT}/docs' || exit 91\nls -la\n`,
      "Expected the command stream to start with a quoted cd guard, then the command",
    );
  });

  it("does not prepend anything when no workDir is requested", async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue("dddd0000-dddd-dddd-dddd-dddddddddddd" as never);
    const mainChild = createMockChild(2222);
    vi.mocked(cp.spawn).mockReturnValue(mainChild);

    const p = runDockerProcess("ls -la");
    await new Promise((r) => setTimeout(r, 10));
    mainChild.emit("close", 0);
    await p;

    assert.strictEqual(mainChild.stdinWrites[0], "ls -la\n");
  });

  it("rejects traversal before spawning docker at all", async () => {
    const p = runDockerProcess("ls", undefined, "../../etc");
    const result = await p;

    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /path traversal/);
    assert.strictEqual(vi.mocked(cp.spawn).mock.calls.length, 0, "No docker process may be spawned for traversal attempts");
  });

  it("threads timeoutMs through the shared wrapper (exit 124 + note)", { timeout: 20_000 }, async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue("eeee0000-eeee-eeee-eeee-eeeeeeeeeeee" as never);
    const mainChild = createMockChild(3333);
    const killChild = createMockChild(4444);
    let spawnCount = 0;
    vi.mocked(cp.spawn).mockImplementation(() => (spawnCount++ === 0 ? mainChild : killChild));

    const p = execCommand("sleep 100", undefined, { timeoutMs: 1500 });

    // Poll until the 1500ms deadline has fired and the kill path ran.
    for (let i = 0; i < 40 && mainChild.kill.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(mainChild.kill.mock.calls.length > 0, "Expected the host-side kill to fire on timeout");

    // Simulate the exec closing as killed (null code); the wrapper then
    // waits for the container-side cleanup before resolving.
    mainChild.emit("close", null);
    killChild.emit("close", 0);

    const result = await p;
    assert.strictEqual(result.exitCode, 124);
    assert.match(result.stderr, /timed out after 2s/);
  });
});
