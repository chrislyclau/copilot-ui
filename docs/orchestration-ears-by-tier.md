# Orchestration EARS Requirements — Reorganized by MVP Tier

Source of truth for IDs and requirement text is `docs/system-requirements.md`
(moved from README.md as of the doc split; README.md now holds only project
orientation plus a pointer) and `docs/roadmap-spec.md`. **No requirement ID
here is renumbered or renamed**, and full requirement text is reproduced
verbatim wherever practical — this document only regroups existing IDs under
a priority axis (MVP vs. built-but-deferrable vs. speculative) and tags each
with its current implementation status as verified against the codebase (not
just against the spec prose). **Exception:** a small number of entries are
abridged for length rather than quoted in full — e.g. the §7.6 multi-provider
item below drops the source's `(copilot-native, Anthropic, Gemini, or local)`
enumeration, and SYS-REQ-017's "Implementation Gap" sub-bullet is condensed
into a parenthetical. Abridged entries are not flagged individually; treat
this document as a routing/status layer and check `docs/system-requirements.md`
directly before relying on exact wording.

Status tags:
- **[BUILT]** — verified present in `src/`, generally with test coverage.
- **[BUILT-ENTANGLED]** — built, but physically interleaved inside `handleGateLoop`
  alongside Tier 1 logic rather than isolated; cannot be toggled off without editing
  the same function that runs the core loop.
- **[PARTIAL]** — some portion built, remainder open.
- **[UNBUILT]** — no corresponding code found.
- **[UNVERIFIED]** — plausible/likely built based on adjacent evidence, not directly
  traced this pass.

**Note on in-code `T0`/`T1`/`T2` comment labels:** `gateLoop.ts` contains its own
informal `// T0:` / `// T1:` / `// T2:` comment tags (e.g. `T0: Ambiguity Checker`,
`T1: Composer Router Classification`, `T2: Fallback Upgrades for Distressed
Pipelines`). **These do not correspond to this document's Tier 0–3 scheme** — e.g.
code's `T0`/`T1` land in this doc's Tier 3, and one `T1` lands in Tier 2. Treat the
in-code labels as a separate, stale numbering scheme, not a cross-reference to the
tiers below. **Update:** these comments have since been renamed in
`gateLoop.ts` to `GATE-STAGE-A/B/C` (comment-only change, no behavior change)
to remove the collision described above. Bundling that comment-only rename
into a spec-document PR required an explicit exception to AGENTS.md's
spec-change PR-isolation rule; that exception was added, with human
confirmation, on its own PR (`docs/agents-exempt-comment-only-changes`) per
the escalation process AGENTS.md itself requires for spec changes.

---

## Tier 0 — agentCore / SessionWrapper (Done — out of scope for this pass)

Listed for completeness only; this is the foundation you already said is settled.
Full text lives in `docs/system-requirements.md` §5.5 and its "SessionWrapper —
Spec Draft (EARS)" section (moved there from README.md's §5.5 / standalone
SessionWrapper section as of the doc split — see below), plus
`docs/SessionWrapper-spec.md` for the current SYS-REQ-028 family. (The
original "§7.5.5" cross-reference here was already inaccurate before this
doc split — §7.5 never had a numbered `.5` subsection — corrected rather
than carried forward.)

- SYS-REQ-024, SYS-REQ-026, SYS-REQ-026a, SYS-REQ-026b, SYS-REQ-026c, SYS-REQ-027
  (+ sub-items), SYS-REQ-028 — **[BUILT]**

---

## Tier 1 — MVP: Core Gate Loop

The minimum for "agent takes a task, mutates code, something checks the work,
retries with limits, escalates or parks, never hangs or corrupts state, runs
unattended." Every item below is already **[BUILT]** unless noted — this tier is not
a to-do list, it's the floor you're already standing on.

### Structured interaction / no free-text mutation

- **ORCH-REQ-001 (Ubiquitous):** The Orchestrator Server shall process LLM agent
  interactions exclusively through structured JSON tool invocations. — **[BUILT]**
- **ORCH-REQ-002 (Ubiquitous):** The Orchestrator Server shall treat everything an LLM
  agent returns outside of an explicit tool call strictly as unstructured plain text.
  — **[BUILT]**
- **ORCH-REQ-004 (Unwanted Behavior):** If the active operational state requires a
  workspace mutation or state transition, while the agent response contains only
  plain text with no valid tool invocation envelope, then the Orchestrator Server
  shall reject the payload from the execution loop and automatically re-prompt the
  agent with a structural syntax schema violation error. — **[BUILT]**

### Memory / turn governance

- **ORCH-REQ-005 (Unwanted Behavior):** If the cumulative character footprint of
  intermediate tool logs crosses 40,000 characters, then the Orchestrator Server
  shall execute an exponential-decay sliding window to truncate verbose logs while
  permanently retaining the original objective and the last 2 operational cycles.
  — **[BUILT]**
- **SYS-REQ-019 (Executor History Preservation):** While executing an assigned
  subtask loop, the Executor role shall retain short-term conversation history for
  troubleshooting, but the system's prompt injection layer shall narrow context focus
  strictly to the active subtask definition and its immediate validation gate
  failures. — **[BUILT]**
- **SYS-REQ-019a (Timeout Policy):** All one-shot and gate-loop agent turns shall run
  through `runForcedToolTurnUntilTimeout` (not a hand-rolled `sendAndWait`), so a
  single hard timeout — not a stall-silence heuristic — governs turn duration. This
  applies uniformly to auditor sessions and standalone scripts, not just
  `gateLoop.ts` call sites. — **[BUILT]**

### Safety circuit

- **ORCH-REQ-006 (Unwanted Behavior):** If the autonomous execution loop reaches
  `MAX_LOOP_CYCLE_CEILING = 10`, then the Orchestrator Server shall park the task
  (transitioning its status to `blocked`, committing or stashing the active
  workspace state, and checkout the base trunk branch), and automatically pull the
  next unblocked task within a PBI to continue execution without a hard system halt.
  — **[BUILT]**
- **RM-REQ-001 (U):** The system shall treat all human-facing checkpoints as
  asynchronous notifications rather than blocking prompts; no orchestration path
  shall pause execution indefinitely awaiting human input. — **[BUILT]** (this is the
  design principle ORCH-REQ-006 is an instance of; roadmap confirms "already
  implemented")

### Code Auditor gate (the actual "gate" in gate loop)

- **ORCH-REQ-007 (Event-Driven):** When an evaluation gate requires an out-of-band
  audit, the Gate Pipeline shall instantiate an ephemeral, distinct runtime context
  for the designated Auditor instance, using the audit mode (ORCH-REQ-007a Stateless
  or ORCH-REQ-007b Summary-Handoff) configured for that gate. Mode selection is
  per-gate/session, not a fixed system-wide architectural choice. — **[BUILT]**
- **ORCH-REQ-007a (Configurable Mode — Absolute Statelessness):** Where strict
  stateless evaluation is configured for a gate, the Orchestrator Server shall
  provide the Auditor instance with only the active workspace diff and immediate
  test failure outputs, completely purging any record of the Auditor's own previous
  audit cycles. — **[BUILT]**
- **ORCH-REQ-007b (Configurable Mode — Ephemeral Summary Handoff):** Where stateful
  tracking is configured for a gate, the Orchestrator Server shall extract a single,
  machine-generated summary token from the Auditor's own immediate previous audit
  cycle and inject it as a read-only parameter into the Auditor's system block.
  — **[BUILT]**
- **ORCH-REQ-008 (State-Driven):** While evaluating an Executor's code changes for
  bugs or syntax errors, the Code Auditor model context shall remain strictly blind
  to the Executor's historical conversation trace, chain-of-thought tokens, and
  intermediate session logs — regardless of which mode is configured. — **[BUILT]**

### Autonomy (no human confirmation blocking the loop)

- **ORCH-REQ-012 (Ubiquitous):** The Orchestrator Server shall execute all workspace
  mutation, file system, and terminal commands automatically without pausing for
  client-side permission or manual authorization tokens. — **[BUILT]**
- **ORCH-REQ-013 (Unwanted Behavior):** If an active agent generates a command
  execution string, then the Verification Gate shall act as an automated logging
  pass-through layer that auto-approves and runs the execution command instantly,
  bypassing all manual human confirmation checkpoints. — **[BUILT]**

### Risk containment

- **ORCH-REQ-014 (Ubiquitous):** The execution loop shall rely exclusively on a
  host-worktree isolated Docker sandbox and Git-based version rollback states to
  mitigate command execution risk and absorb environment errors. — **[BUILT]**
- **SYS-REQ-001:** The system shall not manage docker container's lifecycle.
  `src/agentCore/workspace/dockerRunner.ts` shall receive the container's name via an
  environment variable and assumes the workspace is mounted by volume at a fixed
  location inside the container. — **[BUILT]**

### Provider plumbing (needed for the loop to talk to any model at all)

- **SYS-REQ-004:** The system shall map external model definitions to generic API
  handlers using an abstract provider adapter layer. — **[BUILT]** —
  `src/agentCore/providerRegistry.ts` (`ProviderRegistry.getMappedModel` /
  provider-type resolution).
- **SYS-REQ-005:** The system shall strip unsupported parameters from payloads
  before sending requests to non-native generic compatibility layers. — **[BUILT]**
  — `src/agentCore/providerProxy.ts` explicitly deletes `refusal`, `parsed`, and
  the `accept-encoding` header before forwarding.
- **SYS-REQ-005a:** The browser-side application interface shall not track,
  transmit, or render parameters, options, or controls specific to container
  virtualization engines. — **[UNVERIFIED]** (frontend not traced this pass)
- **SYS-REQ-005b:** The backend owns all state and all state transitions. The
  frontend may act as a thin, user-initiated trigger but must not drive, poll, or
  otherwise orchestrate the execution loop beyond that initial signal. — **[UNVERIFIED]**

### Workspace / git centralization (this is what actually makes tasks and gates safe to run)

- **SYS-REQ-020 (Ubiquitous):** All workspace mutation, Git operations, and terminal
  command execution shall flow exclusively through the three core workspace
  functions exported from `src/agentCore/workspace/index.ts`: `initializeWorkspace()`,
  `getGitSandbox()`, and `getExecCommand()`. — **[BUILT]**
- **SYS-REQ-020a (Unwanted Behavior):** If any module directly imports and uses
  `child_process` methods instead of routing through the centralized workspace API,
  then the system shall fail code review as a violation of architectural boundary
  separation. — **[BUILT]** (process/lint convention, not runtime-enforced — worth
  a lint rule the same way SYS-REQ-026c gets one for SessionWrapper)
- **SYS-REQ-021:** Each task shall run in a dedicated `task/<id>` git branch branched
  off the active trunk base branch. The system trunk branch shall remain untouched
  until human review and final merge/approval. — **[BUILT]**
- **SYS-REQ-021a:** When a task is parked, the system shall commit all existing
  worktree mutations to the active `task/<id>` branch, and then checkout the base
  branch to prepare for the next task. — **[BUILT]**
- **SYS-REQ-022 (Path Space Separation):** The system distinguishes three path
  spaces that must never be substituted for one another (app source tree,
  host-side managed workspace, execution-side managed workspace). — **[BUILT]**
- **SYS-REQ-023:** Any `cwd` passed to `getExecCommand()`, `runTests`, `runLint`, or
  `runWithTimeout` shall be sourced from `getWorkspaceRoot()`, never
  `getWorkspaceHostLocation()` or `process.cwd()`. — **[BUILT]**
- **SYS-REQ-025:** Orchestration logic (gate loop, role dispatch, checkpoint
  handling) shall live in a dedicated module under `src/orchestration/orchestrator/`,
  not inline in Express route handlers. — **[BUILT structurally]** (see caveat below)

  > **Caveat carried over from the earlier audit:** this requirement is satisfied at
  > the directory level, but `gateLoop.ts` is ~3,500 lines dominated by one function.
  > Tier 3 items (Ambiguity Checker, Composer Router, fallback-upgrade logic) are
  > inlined inside that same function. Extracting Tier 1 into its own isolated
  > module is the prerequisite for treating Tier 3 as truly optional rather than
  > load-bearing spaghetti.

### Grounding constraints (cross-cutting, govern all of the above)

- **§7.6 — errors shall fail loud** unless a specific case is later identified for
  graceful fallback. — **[DESIGN CONSTRAINT]**
- **§7.6 — Role parameter independence:** THE SYSTEM SHALL treat prompt, model,
  tools, context, metadata, and response requirements as independently variable per
  role, and SHALL NOT hardcode any of these six inside logic shared across roles.
  — **[DESIGN CONSTRAINT]**
- **§7.6 — Multi-provider, per-tier selection:** WHEN configuring a role's model
  tier, THE SYSTEM SHALL allow the provider to be selected independently per tier,
  rather than enforced globally across all tiers. — **[DESIGN CONSTRAINT]**

---

## Tier 2 — Built and valuable, but not required for a single-task loop to work

These only do something once you have multiple tasks/PBIs in flight, or add an
extra correctness layer on top of the Tier 1 gate. All confirmed built and tested
unless noted. Nothing here needs to be ripped out — it's just correctly "not MVP."

### Spec-Gate Auditor (second correctness layer beyond the Code Auditor)

- **ORCH-REQ-009 (Event-Driven):** When a deterministic gate execution fails or an
  Executor completes a task blueprint, the Gate Pipeline shall instantiate a
  dedicated, out-of-band Spec-Gate Auditor model context as a discrete evaluation
  step distinct from the Code Auditor. *(Scope note: since tasks are now ordered
  within a PBI, the Spec-Gate Auditor's evaluation is scoped to the owning PBI where
  relevant.)* — **[BUILT]**
- **ORCH-REQ-010 (State-Driven):** While evaluating workspace modifications, the
  Spec-Gate Auditor shall accept only the raw code changes (diffs) and the primary
  technical design specification file, remaining completely blind to the Executor's
  conversational history logs, intermediate thought tokens, and internal retry
  attempts. — **[BUILT]**
- **ORCH-REQ-011 (Unwanted Behavior):** If the Spec-Gate Auditor detects a structural
  deviation between the workspace mutations and the rules defined in the
  specification file, then it shall return a structured `SPEC_VIOLATION` tool
  response to the Orchestrator, failing the gate pipeline and forcing the active
  session to alter its task blueprint or escalate. — **[BUILT]**

### PBI hierarchy (schema/data model — Section 0)

- **RM-REQ-000 (U):** The system's decomposition hierarchy shall be `spec (file in
  git) → PBIs (derived, dependency-graphed) → tasks (SQLite, ordered within a PBI) →
  sessions (execution attempts)`, superseding the two-tier `spec → tasks → sessions`
  hierarchy currently described in `README.md`. — **[BUILT]**
- **RM-REQ-001a (U):** A PBI is distinct from a spec item. PBI boundaries are
  derived and are not assumed to align with spec-item boundaries. — **[BUILT]**
- **RM-REQ-002a (U):** The `tasks` table shall gain a foreign key to a new `pbis`
  table (`pbiId`), replacing tasks' current direct association to `specId`.
  — **[BUILT]**
- **RM-REQ-003a (U) [Revised — resolves Issue 121]:** The `pbis` table shall store,
  per PBI: `specId`, a title/description, status (`pending | in_progress | blocked |
  pr_ready | done`), and a `dependsOn: pbiId[]` field. — **[BUILT]**
- **RM-REQ-002 (E):** When a checkpoint requires human judgment before a task or PBI
  can safely continue, the system shall park it and continue processing other
  unblocked work, per ORCH-REQ-006. — **[UNVERIFIED]**
- **RM-REQ-003 (U):** The system shall surface all parked/escalated tasks and PBIs
  in a single async queue, rather than as modal interruptions. — **[UNVERIFIED]**
- **RM-REQ-004 (U):** Every escalation entry shall record which trigger fired, so
  the async queue is self-describing. — **[UNVERIFIED]**

### PBI Derivation (Section 2)

- **RM-REQ-070 (U):** The system shall provide a PBI-derivation operation that
  accepts a `specId`, analyzes the spec document together with the current
  repository state, and produces a set of PBIs via a structured tool call.
  — **[BUILT]**
- **RM-REQ-071 (U):** Each derived PBI shall include a `dependsOn` list referencing
  other PBI IDs in the same derivation batch. — **[BUILT]**
- **RM-REQ-072 (E):** When a PBI-derivation operation is invoked for a `specId` that
  already has persisted PBIs, the system shall treat the new output as a proposed
  diff against the existing PBI set rather than silently overwriting. — **[UNVERIFIED]**
- **RM-REQ-073 (U):** Derived PBIs shall be persisted upon human acceptance of a
  derivation or re-derivation diff. — **[BUILT]**
- **RM-REQ-074 (O):** The system may optionally sync accepted PBIs to an external
  issue tracker via Section 8's provider mechanism. — **[UNBUILT]** (depends on
  Section 8, which is unbuilt — this is correctly optional)

### Full-PBI Compliance Audit (Section 3)

- **RM-REQ-014 (U):** The system shall introduce a PBI-level integration branch
  (`pbi/<pbiId>`), created off trunk when a PBI's first task begins. Each task
  within the PBI shall branch off `pbi/<pbiId>`, and shall be fast-forward-merged
  into `pbi/<pbiId>` upon reaching status `done`. — **[BUILT]**
- **RM-REQ-015 (UB):** If a task's fast-forward merge into `pbi/<pbiId>` would not
  be a fast-forward, the system shall fail loudly and raise an escalation rather
  than attempting a three-way merge. — **[BUILT]**
- **RM-REQ-016 (U):** Checkpoint restoration occurring mid-PBI shall commit onto the
  task's active branch, not directly onto `pbi/<pbiId>`. — **[UNVERIFIED]**
- **RM-REQ-010 (U) [Revised]:** The system shall provide a compliance-audit
  operation, distinct from per-task gates, that evaluates the `pbi/<pbiId>`
  branch's diff against trunk. — **[BUILT]**
- **RM-REQ-011 (E) [Revised]:** When all tasks for a given `pbiId` reach status
  `done`, the system shall automatically trigger a compliance audit for that PBI.
  — **[BUILT]**
- **RM-REQ-012 (O):** The system may also trigger a compliance audit periodically
  prior to full completion. — **[UNVERIFIED — optional]**
- **RM-REQ-013 (E):** When a compliance audit reports one or more findings, the
  system shall create new tasks within the same PBI via a structured tool call.
  — **[BUILT]**
- **RM-REQ-017 (E) [New — resolves Issue 83]:** When a compliance audit for `pbiId`
  reports zero findings, the system shall set the PBI's status to `pr_ready` and
  surface it in the async queue, but shall not automatically merge `pbi/<pbiId>`
  into trunk. — **[BUILT]**

### Dependency-Blocked PBI Escalation (Section 4a)

- **RM-REQ-060 (E) [Revised]:** When the system selects the next PBI to begin work
  on and that PBI's `dependsOn` references a PBI currently `blocked`, the system
  shall park the dependent PBI and raise a single async escalation entry
  referencing the blocking PBI. — **[BUILT]**
- **RM-REQ-061 (U) [Revised]:** A PBI in status `blocked` with no other PBI
  depending on it shall not, by itself, trigger cross-PBI escalation. — **[BUILT]**
- **RM-REQ-062 (U) [Revised]:** Each escalation entry raised under RM-REQ-060 shall
  record the count of PBIs — direct and transitive — depending on the blocked PBI.
  — **[BUILT]**

### Auditor Model Rotation (Section 5)

- **RM-REQ-030 (U):** The system shall maintain a predefined, configured pool of
  auditor models, distinct from ad hoc per-call model selection. — **[BUILT]**
- **RM-REQ-031 (E):** When an auditor is invoked for a new gate/verification
  attempt, the system shall select the next model from the pool using a
  deterministic, non-repeating-until-exhausted rotation. — **[BUILT]**
- **RM-REQ-032 (UB):** If the pool contains only one model, or the selected auditor
  model matches the Implementor's model for that task, the system shall log a
  warning noting reduced decorrelation, but shall not block execution. — **[UNVERIFIED]**
- **RM-REQ-033 (U):** The compliance audit shall select its model according to the
  tiering rule in RM-REQ-021, independent of the per-task rotation pool. — **[UNVERIFIED]**
  (contingent on RM-REQ-020/021/022, which are Tier 3 / unbuilt — see below)

### Manual override / kill switch

- **ORCH-REQ-017 (Event-Driven):** When a user triggers a manual `PANIC_STOP` signal
  from the UI timeline, the Orchestrator Server shall immediately issue a hard
  termination signal (`SIGKILL`) to any running commands. — **[PARTIAL]** — the
  `/api/copilot/panic` route in `serverRuntime.ts` aborts the in-flight LLM
  request thread (`AbortController.abort()`), which covers the "in-flight LLM
  request" half. `SIGKILL`-of-process-group machinery does exist
  (`src/agentCore/workspace/processGroup.ts`), but the panic route does not appear
  to call into it — no confirmed path from panic to killing a running shell
  command. Worth verifying directly with the author before treating this as done.
- **ORCH-REQ-018 (State-Driven):** While in a panicked or aborted state, the
  Orchestrator Server shall persist the session status as
  `MANUAL_INTERVENTION_REQUIRED`, reject all incoming automated agent tool
  mutations, drop the client loading animation. — **[PARTIAL]** — the panic route
  sets a `manualIntervention: true` / `isRunning: false` status flag on the
  session snapshot (functionally equivalent, though not the literal
  `MANUAL_INTERVENTION_REQUIRED` string). Tool-mutation rejection and the
  client-side loading-animation drop are unverified this pass.

---

## Tier 3 — Speculative: unbuilt, or built but unproven/entangled

Per your framing, these are the items whose usefulness is a guess rather than
something the loop demonstrably needs. Two sub-groups: things genuinely not built
yet, and things that *are* built but sit inline inside `handleGateLoop` in a way
that makes "just don't use it" harder than it should be.

### Built, but entangled with Tier 1 logic — extract before judging

- **SYS-REQ-016 (Pre-Flight Clarity Gate):** When a user enters a top-level
  technical goal, the system shall run the Ambiguity Checker Agent as a pre-flight
  validation pass. — **[BUILT-ENTANGLED]** — `gateLoop.ts:1173`. Already
  self-bypasses to execution on internal failure (`gateLoop.ts:1298-1314`), which is
  itself evidence the code doesn't fully trust this gate either.
- **SYS-REQ-017 (Unwanted Behavior):** If the Ambiguity Checker Agent returns a
  clarity coefficient score lower than `0.85`, the orchestrator shall halt
  execution, block the pipeline, and surface the itemized missing variables as an
  actionable checklist. *(Implementation Gap noted in spec itself: clarity
  coefficient computation, return schema, and checklist structure are left to agent
  discretion.)* — **[BUILT-ENTANGLED]**
- **"Composer Router Classification"** (README §6.2 references a `Composer` role;
  code has a distinct block at `gateLoop.ts:1317` doing "Structured Tool Choice"
  classification) — **[BUILT-ENTANGLED, NAMING UNRESOLVED]**. Worth confirming
  during extraction whether this is the same thing as SYS-REQ-018's deferred LLM
  Composer or an unrelated, already-shipped classifier — the overlapping name is
  its own small hazard.
- **"T2: Fallback Upgrades for Distressed Pipelines"** (`gateLoop.ts:2834`) — no
  corresponding numbered requirement found in README or roadmap at all; it exists
  in code with no EARS item governing it. — **[BUILT-ENTANGLED, UNSPECIFIED]**
- **Secondary conversation-history trim** (`gateLoop.ts:694`, comment-tagged
  `T2: Memory guardrails`) — a second, separate truncation path distinct from
  ORCH-REQ-005's 40,000-character exponential-decay window: once
  `conversationHistory.length > 50`, it's sliced down to the last 20 entries on
  session completion. No EARS item in README or roadmap governs this behavior —
  same class of gap as the Fallback Upgrades item above. — **[BUILT,
  UNSPECIFIED]**

### Explicitly deferred by the spec itself

- **SYS-REQ-018 (Dynamic Workflow Composition) [DEFERRED / VOLATILE]:** The system
  capability to dynamically compose custom workflow validation gates, timeout
  thresholds, and retry logic arrays using an LLM Composer agent is deferred to
  Phase 3b. — **[UNBUILT — self-declared deferred]**

### Named as shipped, not actually built

- **Committer** (`docs/system-requirements.md` §2.3, moved from README §2.3) — "Lightweight, single-shot, conventional commit
  message generator... Added alongside Planner, Executor, and Auditor roles."
  — **[UNBUILT]**. No reference anywhere in `src/`.
- **Groomer** (`docs/system-requirements.md` §2.3, moved from README §2.3) — "Spec reconciliation agent... triggered immediately
  upon detection of a specification version change." — **[UNBUILT]**. Roadmap's own
  "Open Items Deliberately Deferred" section independently flags this as
  aspirational, so this isn't a surprise — just flagging that README's phrasing
  ("Added alongside...") should be corrected to match.

### Unbuilt roadmap sections

- **RM-REQ-020, 021, 022 (Tiered Escalation for Compliance Audit)** — **[UNBUILT]**
  per roadmap's own status table ("Ready, depends on Section 3").
- **RM-REQ-040, 041, 042, 043 (Plateau-Based Escalation)** — **[UNBUILT]**, confirmed
  no "plateau" reference anywhere in `gateLoop.ts`.
- **RM-REQ-050, 051, 052, 053 (Spec-Change Notification)** — **[PARTIAL]**. The
  abort/reinject mechanism it reuses (ORCH-REQ-015/016) is built; the re-decomposition
  and non-transition nuances specific to this section are unverified. Roadmap itself
  flags a stale code comment here (`serverRuntime.ts` says `SYS-REQ-015/016`, should
  say `ORCH-REQ-015/016`).
- **RM-REQ-080, 081, 082, 083 (Issue Provider Sync)** — **[UNBUILT]**, roadmap marks
  this "Design-stage" with an open reconciliation problem (RM-REQ-083) blocking
  even the one-way sync from being worth starting.

### Real-time spec patching (built, but a UX nicety layered on the loop, not required by it)

- **ORCH-REQ-015 (Event-Driven):** When a user updates the primary design
  specification via the UI while an agent execution loop is running, the
  Orchestrator Server shall immediately abort the active in-flight LLM request
  thread. — **[BUILT]**
- **ORCH-REQ-016 (State-Driven):** While re-invoking the execution loop immediately
  after an abort event, the Orchestrator Server shall inject a system message
  containing the updated specification text directly into the next prompt layout.
  — **[BUILT]**

### Cockpit UI (README §6 / `docs/system-requirements.md` §7.2–7.4, moved from README §7.2–7.4) — pure presentation layer, zero effect on loop correctness

- SYS-REQ-006, 007, 008 (Verification Frame / View Turn Diff)
- SYS-REQ-009, 009a, 010, 011 (Turn History & Interaction Models)
- SYS-REQ-012, 013, 014, 015 (Immutable Checkpoint Mechanics)

All **[UNVERIFIED]** this pass — didn't trace the UI layer, and per your stated
priority (agentCore → gate loop → "everything else is speculation") they're
correctly last regardless of status.

---

## One process note, not a requirement

`docs/roadmap-spec.md`'s implementation-readiness table (reproduced findings above)
should be updated to reflect that Sections 0, 2, 3, and 4a are now **done**, not
"start here" / "ready to implement" — that table is itself now the most out-of-date
artifact in the repo. Worth a five-minute pass before it misleads anyone else who
reads it as current.
