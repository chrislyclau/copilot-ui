import { assert, describe, it, vi, afterEach } from "vitest";
import { runNativeProcess } from "../workspace/nativeRunner.js";
import { execSync } from "child_process";
import * as os from "os";

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
    
    // We launch a bash command that backgrounds a long sleep.
    // Without process group killing, the `sleep` would outlive the aborted bash parent.
    const p = runNativeProcess(`
      sleep 100 &
      # Give bash some time to start the sleep
      sleep 0.5
    `, ac.signal);
    
    // Wait for the bash shell and its background sleep child to spin up
    await new Promise(r => setTimeout(r, 200));
    
    // Check that the process exists
    let psOutBefore = "";
    try {
      psOutBefore = execSync("ps aux | grep '[s]leep 100' || true").toString();
    } catch (e) {
      // Ignore
    }
    assert.ok(psOutBefore.includes("sleep 100"), "Background sleep process should be running before abort");

    // Abort the process, which should kill the process group
    ac.abort();
    
    const result = await p;
    // When killed via signal, exitCode is usually null
    assert.ok(result.exitCode === null || result.exitCode === 1, "Expected exit code null (SIGKILL) or 1");

    // Give the OS a tiny moment to reap the killed processes
    await new Promise(r => setTimeout(r, 100));

    // Verify the descendant `sleep 100` process is gone
    let psOutAfter = "";
    try {
      psOutAfter = execSync("ps aux | grep '[s]leep 100' || true").toString();
    } catch(e) {
      // Ignore
    }
    assert.strictEqual(psOutAfter.includes("sleep 100"), false, "Descendant process should have been terminated");
  });
});
