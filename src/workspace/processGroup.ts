import { assert, describe, it, vi, beforeEach, afterEach } from "vitest";

const platformMock = vi.fn(() => "linux");
vi.mock("os", () => ({
  platform: () => platformMock(),
}));

import { killProcessGroup } from "../workspace/processGroup";

describe("killProcessGroup", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    originalKill = process.kill;
    platformMock.mockReturnValue("linux");
  });

  afterEach(() => {
    process.kill = originalKill;
    vi.restoreAllMocks();
  });

  it("kills the process group via a negative pid on POSIX", () => {
    const killSpy = vi.fn();
    process.kill = killSpy as any;

    const child: any = { pid: 4242, kill: vi.fn() };
    killProcessGroup(child);

    assert.strictEqual(killSpy.mock.calls.length, 1);
    assert.strictEqual(killSpy.mock.calls[0][0], -4242);
    assert.strictEqual(killSpy.mock.calls[0][1], "SIGKILL");
    assert.strictEqual(child.kill.mock.calls.length, 0, "Should not fall back to child.kill if group kill succeeds");
  });

  it("falls back to child.kill when process-group kill throws", () => {
    process.kill = vi.fn(() => {
      throw new Error("ESRCH: no such process group");
    }) as any;

    const child: any = { pid: 5555, kill: vi.fn() };
    killProcessGroup(child);

    assert.strictEqual(child.kill.mock.calls.length, 1, "Expected fallback to child.kill after group kill throws");
    assert.strictEqual(child.kill.mock.calls[0][0], "SIGKILL");
  });

  it("uses child.kill directly on Windows without attempting process-group semantics", () => {
    platformMock.mockReturnValue("win32");
    const killSpy = vi.fn();
    process.kill = killSpy as any;

    const child: any = { pid: 6666, kill: vi.fn() };
    killProcessGroup(child);

    assert.strictEqual(killSpy.mock.calls.length, 0, "Should not attempt process.kill(-pid) on Windows");
    assert.strictEqual(child.kill.mock.calls.length, 1);
    assert.strictEqual(child.kill.mock.calls[0][0], "SIGKILL");
  });

  it("does nothing if the child has no pid", () => {
    const killSpy = vi.fn();
    process.kill = killSpy as any;
    const child: any = { pid: undefined, kill: vi.fn() };

    killProcessGroup(child);

    assert.strictEqual(killSpy.mock.calls.length, 0);
    assert.strictEqual(child.kill.mock.calls.length, 0);
  });

  it("swallows errors from the child.kill fallback itself rather than throwing", () => {
    process.kill = vi.fn(() => {
      throw new Error("ESRCH");
    }) as any;
    const child: any = {
      pid: 7777,
      kill: vi.fn(() => {
        throw new Error("process already exited");
      }),
    };

    assert.doesNotThrow(() => killProcessGroup(child));
  });
});
