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

**Resolved** (see `docs/copilot-ui-remediation-plan.md` Phase 0-A/2-A): gate execution cwd
now sources from `getWorkspaceRoot()` throughout `src/orchestration/orchestrator/gateLoop.ts` and
`src/orchestration/serverRuntime.ts`; `getDefaultWorkspaceDir()` (`getWorkspaceHostLocation()`) is
reserved for the SDK client's `workingDirectory` only. This distinction is now codified
as SYS-REQ-022/023 in `README.md`. If a new callsite falls back to
`getDefaultWorkspaceDir()` or `process.cwd()` for gate/exec purposes, treat that as a
regression of this fix, not a pre-existing known issue.

## Diagnostics gate fallback can mask real failures

`/api/diagnostics/gates` returns a hardcoded `success: true` "[InMemory Safe Workspace
Fallback]" payload. Confirmed this only fires when the liveness check (`runWithTimeout`)
itself fails — a separate host write-check failure is logged but does *not* trigger the
fallback, so real gates still run whenever the container is actually up. If you touch
this route, keep that invariant intact: fallback firing must stay coupled to genuine
container-down detection, or it will silently report green when gates never ran.

## `any` is a ratchet, not a rewrite

`docs/type-discipline-guide.md` bans `any`/`as any` outright; the codebase still carries
legacy instances (concentrated in `serverRuntime.ts`). `eslint.config.js` enforces
`@typescript-eslint/no-explicit-any` as an **error** in `src/orchestration/orchestrator/**` and
`src/agentCore/copilotSdk/boundary.ts`. `scripts/check-explicit-any.ts` is a secondary check
against `eslint-disable` escape hatches in those same paths; it now fails loudly (non-zero
exit) if its target dirs go missing or empty, rather than silently no-oping, so a future
reorg won't quietly drop coverage again. Enforce the guide on new/touched code. Don't
ignore the guide because old code doesn't follow it, and don't do an unrequested cleanup
pass on unrelated `any`s while working on something else.

## SDK imports go through src/agentCore/copilotSdk/boundary.ts

`@github/copilot-sdk` types and client construction are imported from
`src/agentCore/copilotSdk/boundary.ts`, not from the package directly (SYS-REQ-024) — one seam to
update when the SDK's shape changes, instead of chasing it across files. The boundary
module already exists; new code needing an SDK type should import it from the boundary,
not add a fresh `@github/copilot-sdk` import.

## Orchestration lives under src/orchestration/orchestrator/, not inline in serverRuntime.ts

`handleGateLoop` (formerly ~1300 lines inline in `serverRuntime.ts`) now lives in
`src/orchestration/orchestrator/gateLoop.ts`, with session lifecycle helpers in
`src/orchestration/orchestrator/sessionState.ts` (SYS-REQ-025). `serverRuntime.ts` retains route
registration and cross-cutting state (`activeSessions`, `sseResToSessionId`,
`activeLocks`, `getGlobalClient`, `writeLog`, `getDefaultWorkspaceDir`). Don't add new
orchestration logic inline in route handlers — put it in `src/orchestration/orchestrator/`.

## Orphan processes on abort — resolved via detached process groups

`dockerRunner.ts` and `nativeRunner.ts` spawn with `{ detached: true }` and kill via
`killProcessGroup()` (`src/agentCore/workspace/processGroup.ts`), signaling the whole process
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
`src/agentCore/copilotSdk/boundary.ts`) does not inherit `systemMessage` from the session
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


## Spec as Ground Truth

Agents **SHALL** implement spec items exactly as written. Where an implementation diverges from a spec item, agents **SHALL** modify the implementation to match the spec — never the reverse.

Silence in the spec is not license to relax it. If a spec item does not address a given case, agents **SHALL** treat that as underspecified and escalate for clarification (see below) rather than inferring permissive behavior from the implementation's current behavior.

Agents **SHALL NOT** edit spec documents to make them match the implementation, and **SHALL NOT** leave comments in the codebase that rationalize or normalize a deviation from a spec item (e.g. explaining why code "intentionally" diverges from spec). Any such deviation is a defect to be fixed, not documented as acceptable.

### Handling suspected spec errors

Specs can contain genuine errors — typos, stale values, internal contradictions. Agents are not required to treat every spec item as infallible, but they **SHALL NOT** unilaterally resolve suspected errors by editing the spec or by quietly implementing something other than what the spec says.

If an agent believes a spec item is genuinely erroneous (as opposed to merely inconvenient or harder to implement), it **SHALL**:
1. Implement the spec exactly as written, even if believed to be wrong.
2. Flag the suspected error explicitly to a human reviewer, citing the specific spec item and the reason it appears incorrect.
3. Wait for human confirmation before any spec change is made. Agents **SHALL NOT** make that change themselves.

### Auditor agents

Auditor agents **SHALL NEVER** propose changing the spec to match the implementation. Findings **SHALL** be phrased as implementation violations, not spec deficiencies — e.g. "Implementation violates spec item 4.2" rather than "Spec item 4.2 may need updating to match current behavior." Suspected genuine spec errors follow the escalation path above, not an auditor-initiated spec edit.



### Spec changes require an independent PR

Any change to a spec document **SHALL** be made in its own pull request containing only spec changes — no source code, no test changes, and no implementation changes bundled in the same PR or commit range. This applies regardless of whether the change originated from an agent's escalation or a human's own initiative.

Agents **SHALL NOT** open a spec-change PR on their own initiative. A spec PR may only be opened after a human has reviewed and confirmed a flagged spec error per the escalation process above.

### What Qualifies for an EARS item? **CRITICAL**

An EARS requirement **SHALL** describe the system's behavior in its intended target configuration, independent of the system's construction timeline. While authoring or reviewing a requirement, the agent shall check whether the truth of any clause depends on the codebase's current progress toward that target (e.g., "once implemented," "after the migration," "while partially built"). If it does, the agent shall remove that dependency from the requirement; if the removed information has tracking value, the agent SHALL relocate it to an issue, PBI, or migration plan, not the spec.
