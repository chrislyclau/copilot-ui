This file captures tribal knowledge — non-obvious patterns and past debugging lessons.
Add here when: a fix required multiple attempts, a bug touched files you wouldn't have
guessed, or something worked differently than expected. Keep it high-signal.

---

## Workspace path spaces — do not default to process.cwd()

There are two path spaces, and `runTests`/`runLint`/`getExecCommand()` only accept one
of them:

- `getWorkspaceRoot()` — correct for anything that runs through `getExecCommand()`
  (gates, `runWithTimeout`, any shell command). This is the path as seen _inside_ the
  execution environment.
- `getWorkspaceHostLocation()` — correct for callers touching the Node process's own
  filesystem directly (e.g. `CopilotClient.workingDirectory`).
- `process.cwd()` — the app's own source tree. Never a workspace default.

As of the fix for issue #302, the Docker mount binds the workspace at the same
absolute path inside the container as on the host (`WORKSPACE_HOST_LOCATION`), so
`getWorkspaceRoot()` and `getWorkspaceHostLocation()` now return the *same* value in
Docker mode (previously `getWorkspaceRoot()` returned the container-remapped `/app`
while `getWorkspaceHostLocation()` returned a different host-relative path). Despite
now coinciding in value, keep using the semantically correct function at each callsite
— they can diverge again under a different runner mode (e.g. non-Docker/native
execution), and using the wrong one is still a latent bug even when it happens to work
today.

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
session directly. `run-issue-task.ts` (see the issue #221 tracking comment near
its `PORT` constant) is one such caller: it goes through
`runForcedToolTurnUntilTimeout` directly rather than through
`executeAuditSession`, and already forwards `systemMessage` in its retry
config, so it isn't currently exposed to the #208 failure mode. It also still
lacks the rest of `executeAuditSession`'s accumulated protections (the
nudge/retry loop's other edge cases from #188/#191/#207, and any future
watchdog/mid-turn-resume work) -- re-verify it against those issues before
assuming full parity if this script's session handling changes.

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

## `*.pure.ts` convention (issue #320)

Pure decision logic gets split out of side-effect-heavy code into a co-located
`foo.pure.ts` beside `foo.ts` -- no new directory structure, just a suffix.
This started with issue #301 (`getRunner()` mode selection,
`buildAuditorSessionSettings` tool-list assembly) and issue #320 turned it
into an enforced convention rather than an ad-hoc pattern.

**The rule:** a `*.pure.ts` file may not import anything I/O-bearing --
`fs`, `child_process`, `net`/`http`/`https`, `src/workspace` (or any module
that transitively reaches `getExecCommand`/`getGitSandbox`), or SDK client
modules (`@github/copilot-sdk`, or any module under `src/copilotSdk/`,
e.g. `boundary.ts`/`hardenedSession.ts`). This is enforced by the
`**/*.pure.ts` block in `eslint.config.js`, not just documented -- an
unenforced naming convention drifts silently (see below).

**Why enforcement over naming alone:** `buildAuditorSessionSettings`
(`src/utils/auditorHelper.ts`) was the exact function #301 cited as an
example of pure "config in, tool array out" logic. It wasn't -- it returned
an object containing closures that captured `getExecCommand()` (via
`makeAuditorExecToolHandler`) and an `onResult` callback. Naming that file
`auditorHelper.pure.ts` on the strength of its current shape would have been
a mislabel, and nothing short of a lint rule catches that reliably before it
ships.

**Where the split landed:** `buildAuditorSessionSettings` was split into
`buildAuditorSessionDeclarativeSettings` (`auditorHelper.pure.ts` --
model/provider/systemMessage/tool metadata only, no handlers) and the
original `buildAuditorSessionSettings` (`auditorHelper.ts`, now a thin
wrapper that attaches the `onResult` and `getExecCommand()`-closing
handlers on top of the declarative shape). `isAIStudio()`
(`src/workspace/workspace.pure.ts`) is the second reference case -- it only
reads `process.env`, so it moved as-is with no further split needed.

**Type-level note:** the pure builder above types its `provider` field
using `providerRegistry.ProviderConfig`, not the SDK's own
`SdkProviderConfig` (`src/copilotSdk/boundary.ts`) -- even a type-only
import of an SDK client module from a `*.pure.ts` file trips the same rule.
The cast to `SdkProviderConfig` happens at the impure boundary, in the
`auditorHelper.ts` wrapper, where SDK-shaped output is actually assembled.

**Getting a function into scope for this rule:** if it returns closures
capturing I/O, split it into a declarative pure half and a thin impure
wrapper (see above) rather than just renaming the file -- the lint rule will
catch the mismatch immediately if the split isn't clean.

**Out of scope as of #320:** `getRunner()` (`src/workspace/workspace.ts`)
still returns the `native`/`docker` module namespace directly, both of which
transitively import `child_process` -- it fails this rule too and isn't
"already pure." Splitting it (e.g. returning a plain mode value instead of a
module) is an implementation change that belongs to #301, once this
convention exists to implement against -- don't fold it into a `*.pure.ts`
split without that follow-up issue.
