import { assert, describe, it, vi, afterEach } from "vitest";

const DEFAULT_WORKSPACE_HOST_LOCATION = "/workspace/applet_workspace";

afterEach(() => {
  vi.resetModules();
  delete process.env.WORKSPACE_HOST_LOCATION;
});

describe("Docker workspace host location", () => {
  it("defaults to the compose mount path", async () => {
    delete process.env.WORKSPACE_HOST_LOCATION;
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.strictEqual(getWorkspaceHostLocation(), DEFAULT_WORKSPACE_HOST_LOCATION);
  });

  it("respects an explicit workspace host override", async () => {
    process.env.WORKSPACE_HOST_LOCATION = "/custom/workspace";
    vi.resetModules();

    const { getWorkspaceHostLocation } = await import("../../src/agentCore/workspace/dockerRunner.js");

    assert.strictEqual(getWorkspaceHostLocation(), "/custom/workspace");
  });
});
