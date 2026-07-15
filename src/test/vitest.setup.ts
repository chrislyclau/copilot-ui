import { vi } from 'vitest';

// Lets tests swap in a fresh GitSandbox between runs (e.g. ServerHarness.stop())
// without any consumer-visible change to getGitSandbox()'s real behavior.
let _testSandboxOverride: unknown = null;

export function __setGitSandboxForTests(sandbox: unknown): void {
  _testSandboxOverride = sandbox;
}

vi.mock('../workspace/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/workspace')>();
  return {
    ...actual,
    getGitSandbox: () => (_testSandboxOverride ?? actual.getGitSandbox()) as ReturnType<typeof actual.getGitSandbox>,
  };
});

vi.mock('../services/sessionGarbageCollector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessionGarbageCollector')>();
  return {
    ...actual,
    startSessionGarbageCollector: vi.fn().mockReturnValue(() => {}),
  };
});
