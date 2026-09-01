import { assert, describe, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete process.env.WORKSPACE_HOST_LOCATION;
});

describe("Docker workspace host location", () => {
  it("throws a clear error instead of silently falling back when unset (#446)", async () => {
    // A silent "/tmp/applet_workspace" default is exactly what let this
    // failure mode (#403/#446) reproduce itself invisibly: a step that
    // forgets to set WORKSPACE_HOST_LOCATION should fail loudly at the point
    // of misconfiguration, not fall back to a path the container was never
    // mounted at.
    delete process.env.WORKSPACE_HOST_LOCATION;
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.throws(
      () => getWorkspaceHostLocation(),
      /WORKSPACE_HOST_LOCATION environment variable is not set/,
    );
  });

  it("respects an explicit workspace host override", async () => {
    process.env.WORKSPACE_HOST_LOCATION = "/custom/workspace";
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.strictEqual(getWorkspaceHostLocation(), "/custom/workspace");
  });
});
