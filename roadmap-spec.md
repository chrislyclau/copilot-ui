# Roadmap: CIV Hardening — Compliance Auditing, Escalation, and Spec Currency

Format: [EARS](https://alistairmavin.com/ears/), consistent with `README.md`'s
`ORCH-REQ-*`/`SYS-REQ-*` conventions. New requirement IDs use the `RM-REQ-*` prefix to
avoid collision with existing requirements; cross-references to existing requirements
are given where a new item extends or reuses established behavior.

Legend: **U** = Ubiquitous, **E** = Event-driven, **S** = State-driven, **O** = Optional
feature, **UB** = Unwanted behavior.

**Governing principle:** every item below is a tiering or triggering rule layered on
top of one existing primitive — task parking (ORCH-REQ-006) — rather than a new
blocking mechanism. No requirement in this document introduces a synchronous human
prompt. Where human judgment is required, the task (or PBI) is parked and an async
escalation entry is raised; the human reviews on their own schedule via the existing
escalation queue, never as an in-loop interruption.

**Revision note:** this document originally assumed the flat two-tier hierarchy
described in `README.md` (`spec → tasks → sessions`). Sections 0 and 2 below introduce
a third tier — the PBI (Product Backlog Item) — sitting between spec and task. This is
a real, load-bearing change to the data model, not a renaming: it changes what several
items in this document mean by "spec" or "task" scope, and several original items have
been revised in place (marked **Revised**) rather than superseded, to preserve the
requirement IDs already referenced elsewhere. `README.md`'s own hierarchy line and
ORCH-REQ-006/009 will need a matching update before this document's items can be
considered fully consistent with the base system — tracked as a prerequisite in
**Section 0**, not duplicated here.

**Implementation readiness**, left-to-right, roughly in the order this document
recommends tackling them:

| Section | Status | Why |
|---|---|---|
| 0. Hierarchy prerequisite | **Start here** | Blocks everything below; schema-only change |
| 1. Async HITL | Already implemented | No new work; kept for traceability |
| 2. PBI Derivation | **Ready to implement** | Self-contained; only depends on Section 0's schema |
| 3. PBI Compliance Audit | Ready — branch-strategy decision resolved in Issue 83 | Needs Section 0 schema (done); integration-branch choice (RM-REQ-014/017) now decided |
| 4. Tiered Escalation (Compliance) | Ready, depends on Section 3 | Reuses existing ladder; low risk |
| 4a. Dependency-Blocked PBI Escalation | Ready, depends on Section 0 + 2 | Graph queries now well-defined (see revision note in RM-REQ-062) |
| 5. Auditor Model Rotation | **Ready to implement now** | Fully independent of the PBI work; no dependencies on Sections 0–4a |
| 6. Plateau-Based Escalation | **Ready to implement now** | Independent of the PBI work; only touches task-level gate loop |
| 7. Spec-Change Notification | Already partly implemented | Verify against Section 0 changes; likely no new work |
| 8. Issue Provider Sync | Design-stage | One open item (reconciliation) must close first |

If you want to start coding immediately on something with no upstream dependency,
**Section 5 or Section 6** are the least entangled with everything else that changed
this session.

---

## 0. Hierarchy Prerequisite (Spec → PBI → Task → Session)

Establishes a data-model change that most other sections in this document assume.
Not itself a behavior change — it is schema and terminology, and should land before
Sections 2–4a are implemented.

- **RM-REQ-000 (U):** The system's decomposition hierarchy shall be
  `spec (file in git) → PBIs (derived, dependency-graphed) → tasks (SQLite, ordered
  within a PBI) → sessions (execution attempts)`, superseding the two-tier
  `spec → tasks → sessions` hierarchy currently described in `README.md`.
- **RM-REQ-001a (U):** A PBI is distinct from a **spec item** (a structural unit of the
  spec document, e.g. a markdown section or an individual EARS requirement). PBI
  boundaries are derived (see Section 2) and are not assumed to align with spec-item
  boundaries — a single spec item may contain multiple PBIs, and a single PBI may span
  multiple spec items.
- **RM-REQ-002a (U):** The `tasks` table shall gain a foreign key to a new `pbis` table
  (`pbiId`), replacing tasks' current direct association to `specId`. A task's spec
  association is derived transitively through its PBI.
- **RM-REQ-003a (U):** The `pbis` table shall store, per PBI: `specId`, a title/
  description, status (`pending | in_progress | blocked | done`), and a
  `dependsOn: pbiId[]` field representing edges in the PBI dependency graph (see
  RM-REQ-071).

**Note on ORCH-REQ-006/009:** ORCH-REQ-006's "pull the next unblocked task" and
ORCH-REQ-009's Spec-Gate Auditor scope both currently operate on the old flat
hierarchy and will need corresponding edits in `README.md` once this section lands —
tracked here as a dependency, not restated as a duplicate requirement.

---

## 1. Asynchronous Human-in-the-Loop (Foundational Principle)

- **RM-REQ-001 (U):** The system shall treat all human-facing checkpoints as
  asynchronous notifications rather than blocking prompts; no orchestration path shall
  pause execution indefinitely awaiting human input.
- **RM-REQ-002 (E):** When a checkpoint requires human judgment before a task or PBI
  can safely continue, the system shall park it (transition status to `blocked`,
  commit or stash the active workspace state, checkout the base branch) and continue
  processing other unblocked work, per the existing park-and-continue behavior defined
  in ORCH-REQ-006.
- **RM-REQ-003 (U):** The system shall surface all parked/escalated tasks and PBIs in
  a single async queue (the existing escalation store), rather than as modal
  interruptions, so a human can review at a time of their choosing.
- **RM-REQ-004 (U):** Every escalation entry, regardless of which requirement below
  triggered it, shall record which trigger fired (see RM-REQ-043), so the async queue
  is self-describing without requiring the human to reconstruct why a given item is
  there.

---

## 2. PBI Derivation

**Revised scope note:** PBI derivation is a human-initiated, LLM-executed analysis
step — not an automatic decomposer pass. It is triggered explicitly (today, manually;
this section formalizes that same workflow as a first-class operation), reads both the
spec document and the current state of the codebase, and produces PBIs whose
dependency edges may reflect implementation reality with no textual counterpart in the
spec. There is no cheaper deterministic substitute for this step.

- **RM-REQ-070 (U):** The system shall provide a PBI-derivation operation that accepts
  a `specId`, analyzes the spec document together with the current repository state,
  and produces a set of PBIs via a structured tool call — following the same
  forced-tool-call discipline used for the Auditor and PR Reviewer (cf. RM-REQ-013) —
  rather than freeform prose.
- **RM-REQ-071 (U):** Each derived PBI shall include a `dependsOn` list referencing
  other PBI IDs in the same derivation batch, forming the PBI dependency graph
  consumed by Section 4a.
- **RM-REQ-072 (E):** When a PBI-derivation operation is invoked for a `specId` that
  already has persisted PBIs, the system shall treat the new output as a **proposed
  diff** against the existing PBI set (additions, edge changes, status-incompatible
  removals) rather than silently overwriting persisted PBIs, since re-derivation is
  not guaranteed to reproduce identical boundaries or edges for unchanged spec
  regions.
- **RM-REQ-073 (U):** Derived PBIs shall be persisted (per RM-REQ-003a) upon
  human acceptance of a derivation or re-derivation diff; PBIs are not treated as
  ephemeral or recomputed-on-read.
- **RM-REQ-074 (O):** The system may optionally sync accepted PBIs to an external
  issue tracker via the provider mechanism defined in Section 8, but PBI derivation
  itself has no dependency on any external tracker being configured.

**Open/Unsolved — Groomer role:** no requirement here checks the derived PBI graph
for correctness (wrong edges, missed dependencies, over- or under-scoped PBIs) the way
the Auditor checks code or the Spec-Gate Auditor checks spec compliance. `README.md`
already names a **Groomer** role as aspirational/unimplemented; reviewing
derivation diffs (RM-REQ-072) before acceptance is a concrete, scoped candidate job
for it, but is not specified further here pending its own design pass.

---

## 3. Full-PBI Compliance Audit Phase

**Revised scope note:** originally scoped as "entire workspace diff vs. entire spec
file." Rescoped to operate **per PBI**, not per spec, following the Section 0 hierarchy
change. This also resolves a branch-lifecycle gap identified during review: under the
existing branch-per-task model, no branch ever accumulates more than one task's
changes (`checkoutTaskBranch` always branches fresh off trunk; no merge/fast-forward
step exists anywhere in `git.ts`), so "the entire current workspace diff" was not a
well-defined artifact at spec scope. It is well-defined at PBI scope, given RM-REQ-014
below.

- **RM-REQ-014 (U):** The system shall introduce a PBI-level integration branch
  (`pbi/<pbiId>`), created off trunk when a PBI's first task begins. Each task within
  the PBI shall branch off `pbi/<pbiId>` (rather than off trunk directly), and shall
  be fast-forward-merged into `pbi/<pbiId>` upon reaching status `done`. Trunk remains
  untouched by this merge, consistent with SYS-REQ-021.
- **RM-REQ-015 (UB):** If a task's fast-forward merge into `pbi/<pbiId>` would not be a
  fast-forward (i.e. `pbi/<pbiId>` has diverged from what the task branched off),
  the system shall fail loudly and raise an escalation rather than attempting a
  three-way merge — given sequential (non-parallel) task execution, divergence
  indicates an unexpected upstream state change (e.g. a checkpoint restore) that
  needs human attention, not automatic resolution.
- **RM-REQ-016 (U):** Checkpoint restoration (SYS-REQ-014/015) occurring mid-PBI shall
  commit onto the task's active branch, not directly onto `pbi/<pbiId>`; a restored
  task re-attempts its gate loop and merges per RM-REQ-014 as normal on success.
- **RM-REQ-010 (U) [Revised]:** The system shall provide a compliance-audit operation,
  distinct from per-task gates, that evaluates the `pbi/<pbiId>` branch's diff against
  trunk, checked against the subset of the spec relevant to that PBI.
- **RM-REQ-011 (E) [Revised]:** When all tasks for a given `pbiId` reach status `done`,
  the system shall automatically trigger a compliance audit for that PBI.
- **RM-REQ-012 (O):** The system may also trigger a compliance audit periodically
  (e.g. after every N completed tasks within a PBI) prior to full completion, as a
  standing drift check independent of the end-of-PBI trigger in RM-REQ-011.
- **RM-REQ-013 (E):** When a compliance audit reports one or more findings, the system
  shall create new tasks (within the same PBI) via a structured tool call (the same
  forced-tool-call discipline used for the Auditor and PR Reviewer), not by writing
  prose into `architecture-spec.md` for the existing regex-based decomposer to
  reparse, and shall mark the PBI's completion state as not-yet-satisfied.
- **RM-REQ-017 (E) [New — resolves Issue 83]:** When a compliance audit for `pbiId`
  reports zero findings, the system shall mark the PBI as PR-ready and surface it in
  the async queue (RM-REQ-003) for human review, but shall **not** automatically merge
  `pbi/<pbiId>` into trunk. Per `SYS-REQ-021`, trunk remains untouched until human
  review and final merge/approval; `pbi/<pbiId>` is the agent-owned integration branch
  that a human subsequently opens as a PR against trunk. `pbi/<pbiId>` functions as the
  agents' equivalent of a default branch, scoped per-PBI — no separate agent-wide
  default branch is introduced by this document.

---

## 4. Tiered Escalation for Compliance Audit

- **RM-REQ-020 (S):** While remediation tasks created by a compliance audit (RM-REQ-013)
  are executing, the system shall apply the same tiered escalation policy used for
  ordinary tasks — retry on the same model, then escalate model tier, then park with
  async human notification — rather than a separate hard-coded path for
  compliance-audit remediation.
- **RM-REQ-021 (E):** When a subsequent compliance audit, run after a full remediation
  cycle for the same `pbiId`, still reports findings, the system shall escalate the
  compliance audit itself to the next configured model tier (e.g. from a Gemini-tier
  auditor to a Sonnet-tier auditor) before creating further remediation tasks.
- **RM-REQ-022 (UB) [Revised]:** If a compliance audit at the highest configured tier
  still reports findings after remediation, the system shall park the PBI (not merely
  the individual task) and raise an async human escalation for the PBI as a whole,
  rather than looping indefinitely or silently accepting the remaining findings.

---

## 4a. Dependency-Blocked PBI Escalation

**Revised scope note:** originally written at task-granularity ("task depends on
task"), which conflated tasks (an ordered, self-contained list *within* one PBI, no
dependency edges of their own) with PBIs (the actual nodes of the dependency graph,
per RM-REQ-071). Revised throughout to operate at PBI granularity. A task within a
PBI stalling on its *own* PBI's prior task is an ordinary intra-PBI sequencing issue
handled by existing task ordering — no escalation needed. This section governs only
the cross-PBI case.

- **RM-REQ-060 (E) [Revised]:** When the system selects the next PBI to begin work on
  and that PBI's `dependsOn` (RM-REQ-071) references a PBI currently in status
  `blocked`, the system shall park the dependent PBI (not merely defer it) and raise a
  single async escalation entry referencing the blocking PBI, rather than allowing
  work to begin against an incomplete prerequisite.
- **RM-REQ-061 (U) [Revised]:** A PBI in status `blocked` with no other PBI depending
  on it shall not, by itself, trigger cross-PBI escalation. Parking is a valid resting
  state; time elapsed since parking is not, on its own, an escalation trigger.
- **RM-REQ-062 (U) [Revised]:** Each escalation entry raised under RM-REQ-060 shall
  record the count of PBIs — direct and transitive — depending on the blocked PBI, so
  the async queue (RM-REQ-003) can be sorted by downstream impact rather than by
  recency alone.
  - **Resolution of prior open item:** transitive counting was previously deferred
    pending a dependency-graph representation. With PBIs as explicit graph nodes
    (RM-REQ-071) persisted at derivation time (RM-REQ-073), both direct and transitive
    counts are a standard graph walk over already-available data — no
    branch-ancestry reconstruction needed. This item is no longer open, contingent on
    Section 2 being implemented first.

---

## 5. Auditor Model Rotation

*(Independent of Sections 0–4a; can be implemented in isolation.)*

- **RM-REQ-030 (U):** The system shall maintain a predefined, configured pool of
  auditor models (e.g. an `AUDITOR_POOL` configuration list), distinct from ad hoc
  per-call model selection. **Implementation note:** `auditorHelper.ts`'s
  `getAuditorExecutionConfig()` currently resolves a single `provider`/`model` pair
  from `DEFAULT_ROLES_CONFIG.auditor` — this requires a genuine config-schema change
  (single pair → list) plus a rotation index threaded through session state, not just
  new selection logic layered on the existing single-value config.
- **RM-REQ-031 (E):** When an auditor is invoked for a new gate/verification attempt,
  the system shall select the next model from the pool using a deterministic,
  non-repeating-until-exhausted rotation (e.g. round-robin), rather than always using
  a single fixed auditor model.
- **RM-REQ-032 (UB):** If the pool contains only one model, or the selected auditor
  model for a given attempt matches the Implementor's model for that task, the system
  shall log a warning noting reduced decorrelation for that attempt, but shall not
  block execution on it.
- **RM-REQ-033 (U):** The compliance audit (Section 3) shall select its model
  according to the tiering rule in RM-REQ-021, independent of the per-task rotation
  pool defined in RM-REQ-030 — tiering escalates by capability, rotation diversifies
  by decorrelation, and the two shall not be conflated into a single pool.

---

## 6. Plateau-Based Escalation

*(Independent of Sections 0–4a; can be implemented in isolation.)*

- **RM-REQ-040 (U):** The system shall track, per retry attempt within a task's gate
  loop, the combined count of `blocking`- and `suggestion`-severity findings reported
  by the verifier for that attempt.
- **RM-REQ-041 (S):** While a task is retrying, if the combined blocking+suggestion
  count is flat or increases across two consecutive attempts, the system shall trigger
  escalation immediately, without waiting for `retryCount` to reach `maxRetries`.
- **RM-REQ-042 (E):** When plateau-triggered escalation (RM-REQ-041) fires, the system
  shall follow the same escalation ladder used for ceiling-triggered escalation
  (model-tier escalation, then park with async human notification) — the plateau
  condition changes only the trigger, not the ladder.
- **RM-REQ-043 (U):** The system shall record, on each escalation entry, whether it was
  ceiling-triggered (existing `retryCount === maxRetries` path) or plateau-triggered
  (RM-REQ-041), to support later analysis of which trigger fires most often and
  whether the plateau threshold needs tuning.

---

## 7. Spec-Change Notification for In-Flight Tasks

- **RM-REQ-050 (E):** When `architecture-spec.md` changes while one or more tasks
  derived from it are in status `running`, the system shall notify each affected
  in-flight agent session that the specification has changed, reusing the existing
  abort/inject-and-resume mechanism already defined for real-time spec patching
  (ORCH-REQ-015/ORCH-REQ-016), rather than mutating the task's stored fields in place.
  **Note:** the current implementation (`serverRuntime.ts`, `/api/copilot/spec-patch`)
  is commented `SYS-REQ-015/016`; this should be corrected to `ORCH-REQ-015/016` to
  match `README.md`.
- **RM-REQ-051 (U):** The system shall NOT automatically transition an in-flight task
  to `stale` or `superseded` on spec change; task status transitions remain driven by
  the task's own execution outcome, not by the act of editing the spec. The notified
  agent (RM-REQ-050) is responsible for judging whether its in-progress work is still
  aligned with the change.
- **RM-REQ-052 (UB):** If a task is not currently `running` (e.g. still `pending`) when
  the spec changes, the system shall re-run decomposition against the updated spec for
  that task's not-yet-started portion using existing `decomposeSpecIntoTasks` behavior,
  since there is no active session to notify. **Note:** this requirement governs
  task-level re-decomposition only. It does not trigger PBI re-derivation (Section 2),
  which remains human-initiated per RM-REQ-070 and is unaffected by this requirement.
- **RM-REQ-053 (U):** Given PBI derivation is human-initiated (RM-REQ-070) rather than
  automatic, this section's scope is confirmed to be limited to in-flight *task*
  sessions; no additional requirement is needed here to handle spec changes
  propagating into PBI boundaries or dependency edges.

---

## 8. Issue Provider Sync

**Scope note:** GitHub Issues is currently used as a human-facing, mobile-accessible
client for reviewing and acting on PBIs — not as the system of record. The app must
remain repo-platform-agnostic; SQLite (RM-REQ-003a) is authoritative, and any issue
tracker is an optional, swappable projection, following the same Provider Registry
pattern already used for model selection (`auditorHelper.ts`).

- **RM-REQ-080 (U):** The system shall define an `IssueProvider` interface, with
  `GitHubIssueProvider` as its first implementation, following the existing Provider
  Registry pattern. No orchestration logic (RM-REQ-060, RM-REQ-070, etc.) shall
  depend on any specific provider, or on any provider being configured at all.
- **RM-REQ-081 (E):** When a PBI is created, accepted, or changes status, the system
  may, if an `IssueProvider` is configured, sync that change outward (issue
  created/updated, closed, labeled, or commented) — this direction (SQLite → provider)
  is one-way and best-effort.
- **RM-REQ-082 (O):** Escalation entries (RM-REQ-004) may optionally be mirrored to the
  configured provider (e.g. as an issue comment or label) so they are visible from a
  mobile/no-UI client, independent of whether the app's own UI is being used.
- **RM-REQ-083 (E) — Open/Unsolved:** When a human edits or comments on an issue
  directly on the provider (e.g. from a phone, mid-run) rather than through the app,
  the system needs a reconciliation strategy for the provider → SQLite direction. This
  is structurally the same class of problem Section 7 already solves for spec-file
  edits (external change vs. in-flight orchestrator state), but is not yet specified
  for issue-provider edits specifically. No implementation should begin on two-way
  sync until this is resolved; RM-REQ-081 (one-way, SQLite → provider) is safe to
  implement ahead of it.

---

## Open Items Deliberately Deferred

- **Groomer-as-graph-reviewer** (Section 2) — reviewing PBI-derivation diffs
  (RM-REQ-072) before acceptance is a concrete candidate job for the aspirational
  Groomer role named in `README.md`, but is not specified further here.
- **Provider → SQLite reconciliation** (RM-REQ-083) — two-way issue sync is blocked on
  this; one-way sync (RM-REQ-081) is not.
- A code-tracked, deterministic finding-status mechanism, mirroring `O-6.9` in
  `review-agent-spec.md` — still deferred pending enough runs of the model-judged
  approach (Section 6 above) to show whether its false-negative rate is acceptable.
- Content-quality checks on forced-tool-call output (distinguishing a genuine
  zero-findings result from a hollow/rubber-stamped one) — flagged as a real gap but
  not yet specified; needs its own design pass before EARS items are written.
- A golden-fixture regression harness for auditor model swaps — worth building once
  Section 5's rotation pool is in active use, so there is a stable baseline to regress
  against.
