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

**Resolved** (see `copilot-ui-remediation-plan.md` Phase 0-A/2-A): gate execution cwd
now sources from `getWorkspaceRoot()` throughout `src/orchestrator/gateLoop.ts` and
`src/serverRuntime.ts`; `DEFAULT_WORKSPACE_DIR` (`getWorkspaceHostLocation()`) is
reserved for the SDK client's `workingDirectory` only. This distinction is now codified
as SYS-REQ-022/023 in `README.md`. If a new callsite falls back to
`DEFAULT_WORKSPACE_DIR` or `process.cwd()` for gate/exec purposes, treat that as a
regression of this fix, not a pre-existing known issue.

## Diagnostics gate fallback can mask real failures

`/api/diagnostics/gates` returns a hardcoded `success: true` "[InMemory Safe Workspace
Fallback]" payload. Confirmed this only fires when the liveness check (`runWithTimeout`)
itself fails — a separate host write-check failure is logged but does *not* trigger the
fallback, so real gates still run whenever the container is actually up. If you touch
this route, keep that invariant intact: fallback firing must stay coupled to genuine
container-down detection, or it will silently report green when gates never ran.

## `any` is a ratchet, not a rewrite

`type-discipline-guide.md` bans `any`/`as any` outright; the codebase still carries
legacy instances (concentrated in `serverRuntime.ts`). `eslint.config.js` enforces
`@typescript-eslint/no-explicit-any` as an **error** in `src/orchestrator/**` and
`src/copilotSdk/boundary.ts`, with `scripts/check-explicit-any.ts` as a secondary check
against `eslint-disable` escape hatches. Enforce the guide on new/touched code. Don't
ignore the guide because old code doesn't follow it, and don't do an unrequested cleanup
pass on unrelated `any`s while working on something else.

## SDK imports go through src/copilotSdk/boundary.ts

`@github/copilot-sdk` types and client construction are imported from
`src/copilotSdk/boundary.ts`, not from the package directly (SYS-REQ-024) — one seam to
update when the SDK's shape changes, instead of chasing it across files. The boundary
module already exists; new code needing an SDK type should import it from the boundary,
not add a fresh `@github/copilot-sdk` import.

## Orchestration lives under src/orchestrator/, not inline in serverRuntime.ts

`handleGateLoop` (formerly ~1300 lines inline in `serverRuntime.ts`) now lives in
`src/orchestrator/gateLoop.ts`, with session lifecycle helpers in
`src/orchestrator/sessionState.ts` (SYS-REQ-025). `serverRuntime.ts` retains route
registration and cross-cutting state (`activeSessions`, `sseResToSessionId`,
`activeLocks`, `getGlobalClient`, `writeLog`, `DEFAULT_WORKSPACE_DIR`). Don't add new
orchestration logic inline in route handlers — put it in `src/orchestrator/`.

## Orphan processes on abort — resolved via detached process groups

`dockerRunner.ts` and `nativeRunner.ts` spawn with `{ detached: true }` and kill via
`killProcessGroup()` (`src/workspace/processGroup.ts`), signaling the whole process
group rather than just the direct child. Docker mode additionally runs a container-side
kill pass keyed on an `EXEC_RUN_ID` marker to catch processes the group-kill can't reach
inside the container's PID namespace. If debugging a "still running after abort"
report, check `processGroup.ts` and the container-side kill command in
`dockerRunner.ts` first — this was a known gap, but is now handled.
