# copilot-ui Remediation Plan

Status of each item: **confirmed** (traced/verified), **suspected** (static trace only, needs a repro), or **structural** (no bug, just a seam to add).

## Phase 0 — Resolve open hypotheses (before any refactor)

Two items are suspected bugs, not confirmed. Cheap to verify, expensive to build fixes around if wrong.

| Item | Test | Confirms/kills |
|---|---|---|
| Gate `cwd` resolution in Docker mode | Run a gate loop turn in Docker mode, log the actual `cd` target inside the container vs. `/app` | Whether `DEFAULT_WORKSPACE_DIR` (host path) reaching `getExecCommand()` is a live bug or coincidentally works |
| Panic/abort process-tree kill | Have an agent turn background a long-running child process, trigger panic, check for orphans | Whether `child.kill("SIGKILL")` without `tree-kill` actually leaks processes |

Outcome of each determines whether Phase 2 items below are bug fixes or doc-only confirmations.

## Phase 1 — Structural seams (SDK boundary + orchestrator extraction)

Do these together, not sequentially — extracting the gate loop out of `serverRuntime.ts` touches the same call sites (`getGlobalClient`, SDK types) that the boundary module needs to own. Splitting into two passes means touching those lines twice.

1. Create `src/copilotSdk/boundary.ts`: move `getGlobalClient` and all direct `@github/copilot-sdk` type imports here. Re-export types for the rest of the app.
2. Create `src/orchestrator/`: extract `handleGateLoop` (currently `serverRuntime.ts:1468-2833`) into its own module(s), mirroring the existing `gates/`/`db/`/`services/` split. Route handlers become thin — parse request, call orchestrator, stream response.
3. Update the 6 files currently importing `@github/copilot-sdk` directly (`serverRuntime.ts`, `parser.ts`, `types/events.ts`, `mockEvents.ts`, `auditorHelper.ts`, tests) to consume the boundary instead.

This is the highest-effort, highest-payoff item — it's also the prerequisite for Phase 2 being a localized fix instead of a hunt through a 2990-line file.

## Phase 2 — Correctness fixes (contingent on Phase 0)

- **If gate `cwd` bug confirmed:** source gate/exec `cwd` from `getWorkspaceRoot()`, not `getWorkspaceHostLocation()`. Reserve host location for `CopilotClient.workingDirectory` only. Small change, but only safe to isolate correctly once orchestrator extraction (Phase 1) has already separated these concerns.
- **If orphan-process bug confirmed:** add `tree-kill` (or equivalent process-group signaling) to `nativeRunner.ts`/`dockerRunner.ts` abort paths.
- If either is *not* confirmed, downgrade to an AGENTS.md note explaining why the seemingly-risky pattern is actually safe, so it doesn't get "fixed" into breaking later.

## Phase 3 — Type discipline ratchet

Not a cleanup pass. Add a lint/CI check that fails on *new* `any` in touched files (e.g. diff-based, not repo-wide) so the existing ~450 count stops growing without requiring a dedicated rewrite sprint. Reduce opportunistically when a file is touched for other reasons.

## Phase 4 — Documentation (after structure lands, not before)

README (`SYS-REQ-022` through `025`) and AGENTS.md should describe the *actual* resulting architecture, not the target one written in advance. Land Phases 1-2 first, then write docs against what's true. Drafts for both are ready from the prior message.

## Sequencing summary

```
Phase 0 (verify) → Phase 1 (SDK boundary + orchestrator extraction, combined)
                      → Phase 2 (targeted fixes, now localized)
                      → Phase 4 (docs reflect reality)
Phase 3 (type-check gate) — independent, can start anytime
Test file layout consolidation — independent, low priority, anytime
```
