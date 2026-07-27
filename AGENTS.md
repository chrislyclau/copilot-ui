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

## Stall-watchdog recovery retired in favor of a single hard timeout

`runForcedToolTurn`'s stall watchdog (`sendAndWaitWithAbort`'s 90s-silence
threshold, `sendWithStallRetry`'s resume-then-fresh-session ladder) was built to
recover from dead upstream connections. Every investigated case (PR #136, and a
later PR-review session) turned out to be a slow-but-healthy turn -- long model
reasoning, or one chaining many tool calls -- misdiagnosed as a stall, not an
actual dead connection. Issues #188/#191 patched the watchdog to tolerate silence
during active tool *execution*, but silence during model reasoning/generation (the
observed pattern, `lastEventType=session.usage_info`) has no reliable SDK signal to
distinguish from a real stall. Recovering from a false positive also has its own
cost: `resumeSession()` re-injects the SDK's default system message and busts the
prompt cache (issue #208), making the "recovered" turn slower -- which can itself
look like a second stall.

`runForcedToolTurnUntilTimeout` (`toolCallEnforcement.ts`) is now the path all
callers use: same tool-not-called nudge/retry loop as `runForcedToolTurn`, but a
single hard timeout racing `sendAndWait` directly, with no watchdog and no
mid-turn resume. `executeAuditSession` (`auditorHelper.ts`) and all three
`gateLoop.ts` forced-tool-turn call sites use it.

`runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`, `isStallError`,
and their three existing test files are intentionally left in place, dormant, not
deleted -- **do not delete them as part of unrelated cleanup.** If a genuine stall
is ever observed independently of turn duration, that's the code to reach for
again. Its silence-detection logic is a standalone reusable utility -- see
"Execution-aware silence tracking" below.

## resumeSession() drops the system prompt unless you re-pass it

`client.resumeSession()` (base SDK, wrapped by `CopilotClient.resumeSession` in
`src/copilotSdk/boundary.ts`) does not inherit `systemMessage` from the session
being resumed. Any caller building a `resumeConfig` from scratch and omitting
`systemMessage` will silently fall back to the SDK's full default `copilot-cli`
system prompt (task/sub-agent, sql, report_intent, submit_code_review docs,
etc.) for the rest of the turn -- not an error, just a quietly different agent
for the remainder of the session.

This surfaced as issue #208: `executeAuditSession`'s nudge-retry resume path
(`runForcedToolTurn`'s `resumeConfig` in `toolCallEnforcement.ts`) wasn't
carrying `systemMessage` across the resume, even though the field itself
(`{ mode: "replace", content: ... }`, see `auditorHelper.ts` ~line 251) was
correct. The fix was to also pass it on resume, not to change the field.

This is a general SDK usage rule, not specific to PR review or to
`executeAuditSession` -- it applies to **any** future caller that resumes a
session directly, including retry/resume logic that might later be added to
`run-issue-task.ts` (which does not resume sessions today, but would need this
the moment it does).

## Execution-aware silence tracking

`createExecutionAwareSilenceTracker` (`toolCallEnforcement.ts`) is a standalone
utility for the "how long has the SDK gone quiet" check the (dormant) stall
watchdog above uses: it measures time since the last SDK event, but treats time
spent inside a tool call -- between `tool.execution_start` and
`tool.execution_complete`, the only events bookending it -- as *not* silence, so a
slow-but-healthy tool (`npx tsc`, a large `grep`, a slow `gh` call) isn't
misdiagnosed as a dead connection (issues #188/#191, reproduced on PR #136).

It's event-driven rather than self-subscribing to `session.on` (feed it events via
`recordEvent`), since the SDK only supports one active listener per session and
callers typically need their own listener for other event types too. It's
currently only wired up inside `sendAndWaitWithAbort`'s dormant watchdog, but was
pulled out on its own so the pattern doesn't have to be rediscovered if it's ever
needed by a new call site -- reach for it directly rather than re-deriving the
`tool.execution_start`/`tool.execution_complete` bookkeeping from scratch.
