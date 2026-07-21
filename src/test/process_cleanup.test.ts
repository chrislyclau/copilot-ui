import { assert, describe, it, vi, afterEach } from "vitest";
import { runNativeProcess } from "../workspace/nativeRunner.js";
import { execSync } from "child_process";
import * as os from "os";

/**
 * Polls `check()` at `intervalMs` until it returns true or `timeoutMs`
 * elapses, then returns the last observed value. Used instead of a fixed
 * `setTimeout` wait so the test proceeds as soon as the real condition it
 * cares about is true, rather than assuming a fixed duration is enough --
 * the polling interval is just a cadence, not a correctness assumption.
 */
async function pollUntil(check: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = check();
  while (!last && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = check();
  }
  return last;
}

function isSleep100Running(): boolean {
  try {
    return execSync("ps aux | grep '[s]leep 100' || true").toString().includes("sleep 100");
  } catch (e) {
    return false;
  }
}

describe("Process Cleanup & Orphan Handling", () => {
  afterEach(() => {
    // Cleanup any lingering sleep processes we spawn in these tests
    try {
      execSync("pkill -f 'sleep 100'");
    } catch (e) {
      // Ignored: expected to fail if no processes match
    }
  });

  it("should terminate spawned descendant processes (process group kill) on abort", async () => {
    // This test relies on POSIX process groups to verify orphaned children are killed
    if (os.platform() === "win32") {
      console.log("Skipping process group test on Windows");
      return;
    }

    const ac = new AbortController();
    
    // We launch a bash command that backgrounds a long sleep and then waits
    // on it. Without process group killing, the `sleep` (and the `wait`ing
    // bash parent) would outlive the aborted parent.
    //
    // Deliberately `wait`s on the background job rather than doing a short
    // `sleep 0.5` and exiting: under load (e.g. the full test suite running
    // many processes in parallel), a short-lived parent can race ahead and
    // exit normally (exitCode 0) before the abort signal is even dispatched,
    // making this test flaky. Waiting on the 100s background job means the
    // parent is still alive (and killable) for the full duration of the
    // test regardless of scheduling delays.
    const p = runNativeProcess(`
      sleep 100 &
      wait
    `, ac.signal);
    
    // Wait for the bash shell and its background sleep child to actually
    // spin up and become visible to `ps`, polling instead of assuming a
    // fixed duration is always enough (e.g. under a loaded CI host).
    const spawnedInTime = await pollUntil(isSleep100Running, 5000);
    assert.ok(spawnedInTime, "Background sleep process should be running before abort");

    // Abort the process, which should kill the process group
    ac.abort();
    
    const result = await p;
    // When killed via signal, exitCode is usually null
    assert.ok(result.exitCode === null || result.exitCode === 1, "Expected exit code null (SIGKILL) or 1");

    // Verify the descendant `sleep 100` process is actually gone, polling
    // for its disappearance rather than assuming the OS has reaped it after
    // a fixed delay -- SIGKILL is sent immediately but the kernel reaping
    // the process can lag arbitrarily under load.
    const reapedInTime = await pollUntil(() => !isSleep100Running(), 5000);
    assert.ok(reapedInTime, "Descendant process should have been terminated");
  });
});
