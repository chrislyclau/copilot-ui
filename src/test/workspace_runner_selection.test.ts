import { assert, describe, it, vi, afterEach } from "vitest";

// getRunner() treats NODE_ENV=test / VITEST=true as AI Studio mode (so the
// rest of the suite gets a safe native runner by default). To exercise the
// docker/desktop branches we have to explicitly unset those here, on top of
// the mode-selecting vars, then restore everything afterward.
const ENV_KEYS = ["AI_STUDIO", "NODE_ENV", "VITEST", "RUNNER_MODE", "WORKSPACE_HOST_LOCATION"] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function clearRunnerEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

describe("getRunner() mode selection", () => {
  it("selects the native runner in AI Studio mode", async () => {
    clearRunnerEnv();
    process.env.AI_STUDIO = "true";
    vi.resetModules();

    const workspace = await import("../workspace/workspace.js");
    const native = await import("../workspace/nativeRunner.js");

    assert.strictEqual(workspace.getWorkspaceRoot(), native.getWorkspaceRoot());
  });

  it("selects the desktop runner when RUNNER_MODE=desktop outside AI Studio", async () => {
    clearRunnerEnv();
    process.env.RUNNER_MODE = "desktop";
    process.env.WORKSPACE_HOST_LOCATION = "/host/project";
    vi.resetModules();

    const workspace = await import("../workspace/workspace.js");

    assert.strictEqual(workspace.getWorkspaceRoot(), "/host/project");
    assert.strictEqual(workspace.getWorkspaceHostLocation(), "/host/project");
  });

  it("falls back to the docker runner when neither AI Studio nor desktop mode apply", async () => {
    clearRunnerEnv();
    vi.resetModules();

    const workspace = await import("../workspace/workspace.js");
    const docker = await import("../workspace/dockerRunner.js");

    assert.strictEqual(workspace.getWorkspaceRoot(), docker.getWorkspaceRoot());
  });

  it("prioritizes AI Studio mode over an explicit desktop RUNNER_MODE", async () => {
    clearRunnerEnv();
    process.env.AI_STUDIO = "true";
    process.env.RUNNER_MODE = "desktop";
    process.env.WORKSPACE_HOST_LOCATION = "/host/project";
    vi.resetModules();

    const workspace = await import("../workspace/workspace.js");

    // nativeRunner mints a fresh mkdtemp dir per import, so compare against
    // its known naming pattern rather than a second import's exact value.
    assert.match(workspace.getWorkspaceRoot(), /^\/tmp\/app-/);
  });

  it("desktop mode throws without WORKSPACE_HOST_LOCATION set", async () => {
    clearRunnerEnv();
    process.env.RUNNER_MODE = "desktop";
    vi.resetModules();

    const workspace = await import("../workspace/workspace.js");

    assert.throws(() => workspace.getWorkspaceRoot());
  });
});
