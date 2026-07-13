# copilot-ui Remediation Plan — Status: Complete

All phases below have landed in the codebase. This document is kept as a historical
record of what was done and why, and as a pointer to where each change now lives — not
as a forward-looking task list. If you're looking for current architectural rules, see
`AGENTS.md` and `README.md` (SYS-REQ-022 through SYS-REQ-025); if you're looking for
upcoming work, see `roadmap-spec.md`.

Original status legend: **confirmed** (traced/verified), **suspected** (static trace
only, needed a repro), or **structural** (no bug, just a seam to add). All items below
resolved one way or another; the outcome is noted per item.

---

## Phase 0 — Resolve open hypotheses ✅ both confirmed

### 0-A — Gate `cwd` resolution in Docker mode — **confirmed, fixed**

The suspected bug was real: gate execution fell back to `DEFAULT_WORKSPACE_DIR`
(`getWorkspaceHostLocation()`, a host path) instead of the container-side
`getWorkspaceRoot()`. Fixed in Phase 2-A. See `AGENTS.md`'s "Workspace path spaces"
entry for the current rule, and SYS-REQ-022/023 in `README.md` for the formalized
requirement.

### 0-B — Orphan process on abort/panic — **confirmed, fixed**

Backgrounded child processes inside a container/native shell survived `child.kill()`
on the direct spawned process. Fixed in Phase 2-B via detached process groups. See
`AGENTS.md`'s "Orphan processes on abort" entry.

---

## Phase 1 — Structural seams ✅ landed

### 1-A — `src/copilotSdk/boundary.ts` — **done**

All `@github/copilot-sdk` imports now route through `src/copilotSdk/boundary.ts`.
Enforced going forward by SYS-REQ-024 (`README.md`).

### 1-B — `src/orchestrator/gateLoop.ts` — **done**

`handleGateLoop` was extracted out of `serverRuntime.ts` into
`src/orchestrator/gateLoop.ts`, with session lifecycle helpers split into
`src/orchestrator/sessionState.ts`. `serverRuntime.ts` dropped from ~2800+ lines to
~1500, retaining route registration and cross-cutting session/lock state. Enforced
going forward by SYS-REQ-025 (`README.md`).

---

## Phase 2 — Correctness fixes ✅ landed

### 2-A — Gate `cwd` fix — **done**

`runCwd` now sources from `getWorkspaceRoot()` in both `serverRuntime.ts` and
`src/orchestrator/gateLoop.ts`; `DEFAULT_WORKSPACE_DIR` is reserved for the SDK
client's `workingDirectory` only.

### 2-B — Orphan process fix — **done (Option A: detached process groups)**

`dockerRunner.ts` and `nativeRunner.ts` spawn with `{ detached: true }` and kill via
`killProcessGroup()` (`src/workspace/processGroup.ts`). Docker mode layers on an
additional container-side kill pass keyed on an `EXEC_RUN_ID` marker, since a
process-group kill on the host-side `docker exec` process doesn't reach processes
inside the container's own PID namespace. No new dependency (`tree-kill`) was needed.

---

## Phase 3 — Type discipline ratchet ✅ landed

`eslint.config.js` enforces `@typescript-eslint/no-explicit-any` as an **error** (the
plan's draft suggested starting as a warning; the landed version went straight to
error) in `src/orchestrator/**` and `src/copilotSdk/boundary.ts`. A secondary check,
`scripts/check-explicit-any.ts`, guards against `eslint-disable` escape hatches on top
of the native rule. `serverRuntime.ts`'s pre-existing `any` instances were left alone,
per the original plan.

---

## Phase 4 — Documentation ✅ landed

`README.md` sections SYS-REQ-022 through SYS-REQ-025 and `AGENTS.md` now describe the
boundary module, the orchestrator extraction, and the path-space rule as implemented
architecture, not aspiration.

One documentation debt called out during this work remains open and is now tracked in
`roadmap-spec.md` (RM-REQ-050's note) instead of here: the `/api/copilot/spec-patch`
route in `serverRuntime.ts` is still commented `SYS-REQ-015/016`, which should read
`ORCH-REQ-015/016` to match `README.md`'s actual numbering.
