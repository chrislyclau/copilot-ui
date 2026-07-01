This file captures tribal knowledge — non-obvious patterns and past debugging lessons.
Add here when: a fix required multiple attempts, a bug touched files you wouldn't have
guessed, or something worked differently than expected. Keep it high-signal.

---

## Workspace path spaces — do not default to process.cwd() or getWorkspaceHostLocation()

There are three path spaces, and `runTests`/`runLint`/`getExecCommand()` only accept one
of them:

- `getWorkspaceRoot()` — correct for anything that runs through `getExecCommand()`
  (gates, `runWithTimeout`, any shell command). This is the path as seen _inside_ the
  execution environment (`/app` in Docker mode).
- `getWorkspaceHostLocation()` — correct only for callers touching the Node process's
  own filesystem directly (e.g. `CopilotClient.workingDirectory`). In Docker mode this
  is a _different, host-relative_ path (`./workspace`) than `getWorkspaceRoot()`.
- `process.cwd()` — the app's own source tree. Never a workspace default.

Known live issue: `gates/index.ts` defaults `runTests`/`runLint` cwd params to
`process.cwd()`, and `serverRuntime.ts`'s `DEFAULT_WORKSPACE_DIR` is wired to
`getWorkspaceHostLocation()`, then reused as the cwd for gate execution. Since
`AgentWorkspace.tsx` never sends an explicit `cwd`, this fallback is the _live_ path in
every default run, not an edge case. Confirm whether gates are actually resolving the
right directory in Docker mode before touching this area — the container-relative `cd`
may be silently missing the real code root. If confirmed, the fix is switching the gate
cwd source to `getWorkspaceRoot()` and reserving `getWorkspaceHostLocation()` for the
SDK client only.

## Diagnostics gate fallback can mask real failures

`/api/diagnostics/gates` catches gate execution errors and returns a hardcoded
`success: true` "[InMemory Safe Workspace Fallback]" payload. Confirm this only fires
when the container genuinely isn't up — if it can fire for other reasons, it will report
green when gates never ran.

## `any` is a ratchet, not a rewrite

`type-discipline-guide.md` bans `any`/`as any` outright; the codebase still carries
legacy instances (concentrated in `serverRuntime.ts`). Enforce the guide on new/touched
code. Don't ignore the guide because old code doesn't follow it, and don't do an
unrequested cleanup pass on unrelated `any`s while working on something else.

## SDK imports go through src/copilotSdk/boundary.ts

Once the boundary module exists, `@github/copilot-sdk` types and client construction are
imported from there, not from the package directly — same reasoning as the path-space
rule: one seam to update when the SDK's shape changes, instead of chasing it across
files.
