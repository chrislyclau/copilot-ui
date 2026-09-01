import { assert, describe, it, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ENV_KEYS = ["AI_STUDIO", "NODE_ENV", "VITEST", "WORKSPACE_HOST_LOCATION"] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// getRunner() treats NODE_ENV=test / VITEST=true as AI Studio mode (so the
// rest of the suite gets a safe native runner by default). To exercise the
// Docker branch we have to explicitly unset those here, then restore
// everything afterward.
function clearRunnerEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

describe("dockerRunner path resolution off WORKSPACE_HOST_LOCATION", () => {
  // dockerRunner.ts is imported directly (rather than via workspace.ts) in
  // each of these cases: repeated dynamic imports of workspace.ts within a
  // single file don't reliably pick up a fresh dockerRunner instance across
  // vi.resetModules() calls, since workspace.ts closes over dockerRunner via
  // a static import at its own module top. Importing dockerRunner.ts
  // directly avoids that indirection and reliably reflects the current env.
  it("throws instead of defaulting when WORKSPACE_HOST_LOCATION is unset (#446)", async () => {
    // Regression guard for #446: a silent fallback to a fixed path (e.g.
    // "/tmp/applet_workspace") is what let a step omitting the var reproduce
    // #403 invisibly. getWorkspaceRoot()/getGitDir() must fail fast instead.
    clearRunnerEnv();
    vi.resetModules();

    const docker = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.throws(
      () => docker.getWorkspaceRoot(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/,
    );
    assert.throws(
      () => docker.getGitDir(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/,
    );
  });

  it("resolves getWorkspaceRoot()/getGitDir() off a custom host-mirrored WORKSPACE_HOST_LOCATION, not a fixed in-container path", async () => {
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/custom/host/workspace";
    vi.resetModules();

    const docker = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.strictEqual(docker.getWorkspaceRoot(), "/custom/host/workspace");
    assert.strictEqual(docker.getWorkspaceHostLocation(), "/custom/host/workspace");
    assert.strictEqual(docker.getGitDir(), "/custom/host/workspace/snapshots/.git");
  });

  it("holds the host-mirroring invariant: getWorkspaceRoot() === getWorkspaceHostLocation()", async () => {
    // This is the regression guard called out in the issue: a future edit
    // reintroducing a fixed in-container path (e.g. "/app") independent of
    // WORKSPACE_HOST_LOCATION would break SDK tools that expect
    // host-identical paths, and would silently pass every other test that
    // only checks one side or the other.
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/another/custom/path";
    vi.resetModules();

    const docker = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.strictEqual(docker.getWorkspaceRoot(), docker.getWorkspaceHostLocation());
  });
});

describe("getRunner() Docker branch delegation", () => {
  it("workspace.ts delegates getWorkspaceRoot()/getWorkspaceHostLocation() to the Docker runner outside AI Studio mode", async () => {
    clearRunnerEnv();
    process.env.WORKSPACE_HOST_LOCATION = "/delegated/path";
    vi.resetModules();

    const workspace = await import("../../src/agentCore/workspace/workspace.js");

    assert.strictEqual(workspace.getWorkspaceRoot(), "/delegated/path");
    assert.strictEqual(workspace.getWorkspaceHostLocation(), "/delegated/path");
  });
});

describe("docker-compose.yml mount configuration", () => {
  it("mounts WORKSPACE_HOST_LOCATION to an identical source and target path", () => {
    // Guards against compose drift: if the mount's source and target ever
    // diverge (e.g. someone hardcodes the container side back to /app), SDK
    // tools that expect host-identical paths break silently. This parses the
    // actual compose file rather than a copy, so it fails loudly on drift.
    const composePath = path.join(__dirname, "..", "..", "docker-compose.yml");
    const compose = fs.readFileSync(composePath, "utf-8");

    const mountLine = compose
      .split("\n")
      .find((line) => line.includes("WORKSPACE_HOST_LOCATION") && line.includes(":"));

    assert.isDefined(mountLine, "Expected a WORKSPACE_HOST_LOCATION volume mount line in docker-compose.yml");

    // A volume line of the form "- ${VAR:-default}:${VAR:-default}" has the
    // same substitution expression on both sides of the colon.
    const match = mountLine!.trim().match(/^-\s*(\$\{WORKSPACE_HOST_LOCATION[^}]*\}):(\$\{WORKSPACE_HOST_LOCATION[^}]*\})$/);

    assert.isNotNull(
      match,
      `Expected mount source and target to both be \${WORKSPACE_HOST_LOCATION...}, got: ${mountLine}`
    );
    assert.strictEqual(match![1], match![2], "Mount source and target must use the identical WORKSPACE_HOST_LOCATION expression");
  });
});
