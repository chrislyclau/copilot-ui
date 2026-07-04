import type { ChildProcess } from "child_process";
import * as os from "os";

/**
 * Kills a detached child's entire process group (SIGKILL), falling back to
 * killing just the child if group-kill isn't available (e.g. Windows, or the
 * group has already exited). Shared by dockerRunner and nativeRunner so the
 * two host-side kill paths don't drift independently.
 */
export function killProcessGroup(child: ChildProcess): void {
  try {
    if (!child.pid) return;
    if (os.platform() !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        console.warn(`Failed to kill process group for child ${child.pid}:`, e);
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  } catch (e) {
    console.warn(`Fallback kill failed for child ${child.pid}:`, e);
  }
}
