# Project Summary: Copilot SDK UI Agent.

### What It Is

Express + Vite/React app wrapping `@github/copilot-sdk`. Streams real SDK events via SSE (POST + `ReadableStream` reader). Gemini models accessed via OpenAI compatibility layer (`[generativelanguage.googleapis.com/v1beta/openai/](https://generativelanguage.googleapis.com/v1beta/openai/)`). UI renders a live event timeline with filtering, inspection, and stats.

---

### Design Principles (varying degree of certainties)

- **High:** Deterministic gates (test/lint/audit) as retry loops with limits.
- **High:** Expensive model as planner, cheap model as executor.
- **High:** Role-based model assignment supporting heterogeneous providers per loop (Planner, Executor, Auditor, Committer, Groomer).
- **High:** **Executor Narrow Focus with Cumulative Working Memory** — The executor retains active conversational history to troubleshoot errors comparatively, but the prompt injection layer narrows focus strictly to subtasks and immediate gate failures.
- **High:** HTTP/SSE Decoupling — The Express handler enqueues tasks and returns immediately (fire-and-forget). A background worker owns the execution loop, ensuring resilience against client disconnects.
- **High:** Favor automation over human checkpoints (human effort is the premium resource; UI serves as an ambient notification surface, not an interruption screen).
- **High:** Structured output always via tool calls, never prompted raw JSON text blocks.
- **Medium:** Automated decision logging via immutable runtime audit trail.
- **Medium:** Persistent, versioned task decomposition artifacts (SQLite) rather than throwaway conversational breakdowns.
- **Medium:** Task-Based Execution — The planner (expensive model) decomposes a user goal into structured tasks stored in SQLite (`pending → running → blocked | done`). This creates a hierarchy of `spec (file in git) → tasks (SQLite) → sessions (execution attempts)`. The executor (cheap model) receives one task at a time as a narrow directive, with each task subject to the standard gate loop. Cross-task context is preserved via a workingMemory summary — appended after each completed task and injected as a prefix to the next. Blockers filed during execution route through the resolver/escalation mechanism.
  - **Working Memory Contract Defined:**
    - (1) **Schema/Format:** Structured markdown summary tokens comprising `[Task Summary]`, `[Key Decisions]`, and `[Pending Blockers]`.
    - (2) **Size/Token Limit:** Capped strictly at 40,000 characters (approx. 8,000 tokens) to guarantee compatibility with Gemini context bounds.
    - (3) **Truncation Policy:** Handled via `enforceWorkingMemoryTruncation` (exponential decay retaining the root goal at index 0 and sliding operational cycles).
    - (4) **Persistence Strategy:** Stored in-memory per session record (`session.conversationHistory`) and synced seamlessly to the state snapshot for diagnostic auditing.
- **Low:** LLM workflow composers for dynamic subworkflows.
- **Low/Deferred:** Dedicated LLM intent-deciphering steps per prompt (unnecessary due to robust human escalation tier).

---

## 1. Core Orchestration & Tool Constraints

### 1.1 Intent Processing & Structure Enforcement

- **ORCH-REQ-001 (Ubiquitous):** The Orchestrator Server shall process LLM agent interactions exclusively through structured JSON tool invocations.
- **ORCH-REQ-002 (Ubiquitous):** The Orchestrator Server shall treat everything an LLM agent returns outside of an explicit tool call strictly as unstructured plain text.
- **ORCH-REQ-004 (Unwanted Behavior):** **If** the active operational state requires a workspace mutation or state transition, **while** the agent response contains only plain text with no valid tool invocation envelope, **then** the Orchestrator Server shall reject the payload from the execution loop and automatically re-prompt the agent with a structural syntax schema violation error.

### 1.2 Memory Optimization & Truncation

- **ORCH-REQ-005 (Unwanted Behavior):** **If** the cumulative character footprint of intermediate tool logs crosses 40,000 characters, **then** the Orchestrator Server shall execute an exponential-decay sliding window to truncate verbose logs while permanently retaining the original objective and the last 2 operational cycles.

### 1.3 Safety Circuits

- **ORCH-REQ-006 (Unwanted Behavior):** **If** the autonomous execution loop reaches `MAX_LOOP_CYCLE_CEILING = 10`, **then** the Orchestrator Server shall park the task (transitioning its status to `blocked`, committing or stashing the active workspace state, and checkout the base trunk branch), and automatically pull the next unblocked task to continue execution without a hard system halt.

---

## 2. Boundary Context Enforceability & Agents Architecture

### 2.1 The Code Auditor & Spec-Gate Isolation Matrix

- **ORCH-REQ-007 (Event-Driven):** **When** an evaluation gate requires an out-of-band audit, the Gate Pipeline shall instantiate an ephemeral, distinct runtime context for the designated Auditor instance, using the audit mode (ORCH-REQ-007a Stateless or ORCH-REQ-007b Summary-Handoff) configured for that gate. Mode selection is per-gate/session, not a fixed system-wide architectural choice.

#### Mode A: Absolute Statelessness

- **ORCH-REQ-007a (Configurable Mode):** **Where** strict stateless evaluation is configured for a gate, the Orchestrator Server shall provide the Auditor instance with only the active workspace diff and immediate test failure outputs, completely purging any record of the Auditor's own previous audit cycles.
- _Requirement Stability:_ **Stable — both modes are supported and configurable per gate/session, not a one-time architecture choice (see ORCH-REQ-007).**

#### Mode B: Ephemeral Summary Handoff

- **ORCH-REQ-007b (Configurable Mode):** **Where** stateful tracking is configured for a gate, the Orchestrator Server shall extract a single, machine-generated summary token from the Auditor's own immediate previous audit cycle and inject it as a read-only parameter into the Auditor's system block.
- _Requirement Stability:_ **Stable — both modes are supported and configurable per gate/session, not a one-time architecture choice (see ORCH-REQ-007).**
- _Architectural Design Decision:_ If Mode B is selected during implementation, the injected token must be strictly limited to a declarative list of previously rejected code states to prevent the Auditor from developing an evaluation bias or reading conversational prose logs.
- _Scope Note:_ This summary token concerns only the Auditor's continuity with its own prior audit verdicts. It is unrelated to, and does not affect, ORCH-REQ-008's isolation of the Auditor from the Executor's session.

- **ORCH-REQ-008 (State-Driven):** **While** evaluating an Executor's code changes for bugs or syntax errors, the Code Auditor model context shall remain strictly blind to the Executor's historical conversation trace, chain-of-thought tokens, and intermediate session logs — regardless of which mode (ORCH-REQ-007a/007b) is configured. Exceptions to this isolation are out of scope for this system.

### 2.2 The Spec-Gate Auditor Role

- **ORCH-REQ-009 (Event-Driven):** **When** a deterministic gate execution fails or an Executor completes a task blueprint, the Gate Pipeline shall instantiate a dedicated, out-of-band Spec-Gate Auditor model context as a discrete evaluation step distinct from the Code Auditor.
- **ORCH-REQ-010 (State-Driven):** **While** evaluating workspace modifications, the Spec-Gate Auditor shall accept only the raw code changes (diffs) and the primary technical design specification file (e.g., `architecture-spec.md`), remaining completely blind to the Executor’s conversational history logs, intermediate thought tokens, and internal retry attempts.
- **ORCH-REQ-011 (Unwanted Behavior):** **If** the Spec-Gate Auditor detects a structural deviation between the workspace mutations and the rules defined in the specification file, **then** it shall return a structured `SPEC_VIOLATION` tool response to the Orchestrator, failing the gate pipeline and forcing the active session to alter its task blueprint or escalate.

### 2.3 Additional Agent Roles & System Outputs

- **Committer** — Lightweight, single-shot, conventional commit message generator. Automatically runs upon task completion or checkpointing to produce standardized, structured git commit descriptions. Added alongside Planner, Executor, and Auditor roles.
- **Groomer** — Spec reconciliation agent. Classification-only role triggered immediately upon detection of a specification version change to identify structural discrepancies and align tasks.
- **End-of-run Digest** — A generated system artifact (non-agent system output) produced at the end of each orchestration run to summarize execution results, gate statuses, and final outputs.

---

## 3. Automation Enforcement (Human-Out-Of-The-Loop)

### 3.1 Command Execution Autonomy

- **ORCH-REQ-012 (Ubiquitous):** The Orchestrator Server shall execute all workspace mutation, file system, and terminal commands automatically without pausing for client-side permission or manual authorization tokens.
- **ORCH-REQ-013 (Unwanted Behavior):** **If** an active agent generates a command execution string, **then** the Verification Gate shall act as an automated logging pass-through layer that auto-approves and runs the execution command instantly, bypassing all manual human confirmation checkpoints.

### 3.2 Host-Isolation & Risk Absorption

- **ORCH-REQ-014 (Ubiquitous):** The execution loop shall rely exclusively on host-worktree isolated Docker sandboxes (derived dynamically from a host-path directory hash) and Git-based version rollback states to mitigate command execution risk and absorb environment errors.

---

## 4. Human-Interruptible Upgrades (Asynchronous Interception)

### 4.1 Real-Time Specification Patching (Abrupt Abort & Re-Prompt)

- **ORCH-REQ-015 (Event-Driven):** **When** a user updates the primary design specification via the UI while an agent execution loop is running, the Orchestrator Server shall immediately abort the active in-flight LLM request thread.
- **ORCH-REQ-016 (State-Driven):** **While** re-invoking the execution loop immediately after an abort event, the Orchestrator Server shall inject a system message containing the updated specification text directly into the next prompt layout, commanding the agent to continue and adapt its strategy.

### 4.2 Asynchronous Panic Break (Loop Abort)

- **ORCH-REQ-017 (Event-Driven):** **When** a user triggers a manual `PANIC_STOP` signal from the UI timeline, the Orchestrator Server shall immediately issue a hard termination signal (`SIGKILL`) to any running commands.
- **ORCH-REQ-018 (State-Driven):** **While** in a panicked or aborted state, the Orchestrator Server shall persist the session status as `MANUAL_INTERVENTION_REQUIRED`, reject all incoming automated agent tool mutations, drop the client loading animation.

---

## 5. System Topology & Operational Pillars

### 5.1 Abstract Provider Registry

To guarantee the platform is strictly model-agnostic, all core orchestrator modules communicate exclusively with an abstract provider interface. This layer decouples internal execution logic from any provider-specific schemas or mutations.

- **Payload Normalization:** Upstream adapters dynamically scrub structural parameters that break alternative strict OpenAI-compatible or Anthropic-compatible endpoints (e.g., stripping proprietary parsing configurations).
- **Model Tier Mapping:** Models are registered centrally and bound to generalized processing profiles (_Baseline, Intermediate, Advanced_) rather than specific commercial brand names.

### 5.2 Host-Container Volume Handoff & Git Guard Rail

All workspace management is handled via the src/workspace code, to which changes are not permitted without a discussion.

- **SYS-REQ-022 (Path Space Separation):** The system distinguishes three path spaces that must never be substituted for one another:
  1. **App source tree** (`process.cwd()` at server boot) — the copilot-ui repo itself.
  2. **Host-side managed workspace** (`getWorkspaceHostLocation()`) — the managed workspace as visible to the Node process itself (e.g. for direct fs calls, mounting).
  3. **Execution-side managed workspace** (`getWorkspaceRoot()`) — the managed workspace as visible _inside_ wherever `getExecCommand()` actually runs (container path in Docker mode; identical to host path in native mode).
- **SYS-REQ-023:** Any `cwd` passed to `getExecCommand()`, `runTests`, `runLint`, or `runWithTimeout` **shall** be sourced from `getWorkspaceRoot()`, never `getWorkspaceHostLocation()` or `process.cwd()`. `getWorkspaceHostLocation()` is reserved for callers that operate directly against the Node process's own filesystem view (e.g. `CopilotClient`'s `workingDirectory`).

### 5.3 SDK Import Boundary

- **SYS-REQ-024:** All `@github/copilot-sdk` imports **shall** be confined to `src/copilotSdk/boundary.ts`. No other module may import from `@github/copilot-sdk` directly; they consume re-exported types and wrapper functions from the boundary module instead.
- **SYS-REQ-025:** Orchestration logic (gate loop, role dispatch, checkpoint handling) **shall** live in a dedicated module under `src/orchestrator/`, not inline in Express route handlers. Route handlers parse the request, call into the orchestrator module, and stream the result.

### 5.4 Strict Architectural Layer-Boundary Separation

To maintain portability and resilience across varying container virtualization environments, the frontend application must remain completely decoupled from host infrastructure constraints and execution modes.

- **Frontend Blindness:** The user interface displays purely high-level verification outcomes and is strictly forbidden from maintaining state hooks, checkboxes, or payload parameters related to Docker, host bypass, or sandbox mechanisms (e.g., `bypassDocker`).
- **Transparent Server Routing:** The server-side execution pipeline must handle environment diagnostics out-of-band using `DIAGNOSTIC_MODE` and local capabilities detection. When container engines are unreachable, the backend must transparently fall back to native child-process run-paths without exposing virtual-execution parameters to the frontend interface.

---

## 6. Streamlined "Cockpit" & Turn History Layout

```
┌───────────────────────────────────────┬───────────────────────────────────────┐
│                                       │           TURN HISTORY SIDEBAR        │
│                                       │ ┌───────────────────────────────────┐ │
│                                       │ │ ▼ Turn 2: Implement Auth Router 🟢│ │
│                                       │ │   • Planner: Tasks Generated      │ │
│          VERIFICATION FRAME           │ │   • Executor: Mutation Complete   │ │
│                                       │ │   • Gate Run: runTests 🟢         │ │
│ ┌───────────────────────────────────┐ │ │   [Restore Checkpoint]            │ │
│ │  src/server.ts      [ +42 ] [ -12 ]│ │ ├───────────────────────────────────┤ │
│ │  src/routes/auth.ts [ +110] [ -0  ]│ │ ▶ Turn 1: Setup Scaffold  🟢       │ │
│ │                                   │ │ └───────────────────────────────────┘ │
│ │  [ View Turn Diff ]               │ ├───────────────────────────────────────┤ │
│ └───────────────────────────────────┘ │         GOAL AMBIGUITY LEDGER         │
│                                       │ 🟡 Input lacks database target schema │
│                                       │ [ Clarity Score: 0.72 ] [ Re-check ]  │
└───────────────────────────────────────┴───────────────────────────────────────┘

```

### 6.1 Left Column: The Verification Frame

- **AI Studio File Badges:** Displays a flat list of modified file paths rendered as high-contrast chips displaying numerical insertions and deletions (e.g., `src/server.ts +42 -12`).
- **Turn Diff Trigger:** Features a prominent **"View Turn Diff"** button. Clicking this launches a full-screen unified diff overlay showing every code modification executed across the active Git HEAD.
- **Source of Truth:** The Verification Frame is decoupled from the selection state of the Turn History Sidebar. It computes file chips and unified diff structures directly from the workspace's active Git HEAD.

### 6.2 Right Column: The Turn History Sidebar

- **Milestone Grouping:** Telemetry and background tool logs are hidden by default. Turns pull their text labels dynamically from the Planner's task decomposition artifacts emitted via structured tool calls. Each turn block displays a categorical status badge (🟢 / 🔴).
- **Action Breadcrumbs:** Clicking an item expands a read-only sequential breakdown of agent micro-actions (e.g., `Planner: Generated tasks`, `Composer: Assembled blueprint`).
- **Gate Failure Isolation:** Clicking a failed gate node within the active breadcrumb expands inline to display the raw `stderr` / failure buffer output. **This inline expansion acts as the single, exclusive surface for viewing raw validation gate outputs within the application.**

---

## 7. Formal System Requirements (EARS)

### 7.1 Workspace & Environment Integration

- **SYS-REQ-001:** The system **shall** not manage docker container's lifecycle. src/workspace/dockerRunner.ts **shall** receive the container's name via an environment variable and assumes the workspace is mounted by volume at a fixed location inside the container.

- **SYS-REQ-004:** The system **shall** map external model definitions to generic API handlers using an abstract provider adapter layer.
- **SYS-REQ-005:** The system **shall** strip unsupported parameters from payloads before sending requests to non-native generic compatibility layers.
- **SYS-REQ-005a:** The browser-side application interface **shall not** track, transmit, or render parameters, options, or controls specific to container virtualization engines (such as Docker bypasses).
- **SYS-REQ-005b:** The backend owns all state and all state transitions. The frontend may act as a thin, user-initiated trigger (e.g. a button that fires a single request) but must not drive, poll, or otherwise orchestrate the execution loop beyond that initial signal.

### 7.2 Verification UI & View Turn Diff

- **SYS-REQ-006:** The system **shall** display a flat list of modified file paths as visual chips showing lines added and removed in the Verification Frame computed from the current active Git HEAD.
- **SYS-REQ-007:** The system **shall** provide an explicit "View Turn Diff" button adjacent to the modified file list.
- **SYS-REQ-008:** **When** the user clicks the "View Turn Diff" button, the system **shall** launch a full-screen unified diff overlay displaying the code changes within the specific Git commit SHA range boundary bounded by that active execution turn.

### 7.3 Turn History & Interaction Models

- **SYS-REQ-009 (Turn Structure Refactor):** The system **shall** group streaming telemetry events inside parent Turn data containers initialized by the orchestrator core loop, replacing the un-grouped timeline array structure.
- **SYS-REQ-009a (Explicit SHA Binding):** **When** a Turn block concludes with a passing status, the server **shall** emit a completion payload containing the unique Git commit SHA tied directly to that Turn's lifecycle data structure.
- **SYS-REQ-010:** **When** a turn is clicked, the Turn History Sidebar **shall** expand to show a read-only chronological sequence of agent action breadcrumbs.
- **SYS-REQ-011:** **When** a failed gate node within an action breadcrumb sequence is clicked, the system **shall** expand the item inline to render the raw terminal `stderr` failure buffer.

### 7.4 Immutable Checkpoint Mechanics

- **SYS-REQ-012:** The system **shall** make a "Restore Checkpoint" action button available for each completed item inside the Turn History Sidebar.
- **SYS-REQ-013:** **While** an autonomous workflow execution run is active, the system **shall** disable and lock all "Restore Checkpoint" action buttons.
- **SYS-REQ-014 (Forward-Moving Restoration):** **When** a user triggers "Restore Checkpoint" outside of an active execution run, the system **shall** pass the specific Turn's bound commit SHA to the backend to project that exact file state onto the current working directory.
- **SYS-REQ-015 (Dynamic History Append Naming):** The system **shall** commit the resulting working tree delta using a clear, task-descriptive commit label format (`Restore to Checkpoint: [Original Planner Task Label]`) to ensure the Git tracking history remains completely linear and unbroken.
  - _Immutability Constraint:_ Git history is append-only. Restoration does **not** rewind, reset, or mutate any existing commits — it applies the target state as a new forward commit on top of the current HEAD.

### 7.5 Core Loop & Agent Scopes

#### Pre-Flight Clarity Gate

- **SYS-REQ-016:** **When** a user enters a top-level technical goal, the system **shall** run the Ambiguity Checker Agent as a pre-flight validation pass.
- **Scope Note:** The Ambiguity Checker operates strictly at the goal/specification level to confirm alignment and prevent structural contradictions before the orchestrator core launches. It does not perform per-prompt intent decoding.
- **SYS-REQ-017:** **If** the Ambiguity Checker Agent returns a clarity coefficient score lower than `0.85`, the orchestrator **shall** halt execution, block the pipeline, and surface the itemized missing variables as an actionable checklist.
  - _Implementation Gap:_ The method for computing the clarity coefficient, the Ambiguity Checker's return schema, and the structure of the checklist surfaced to the user are intentionally left to agent discretion. The implementation may be revised if the chosen approach proves unsatisfactory.

#### Dynamic Workflow Composition [DEFERRED / VOLATILE]

- **SYS-REQ-018:** The system capability to dynamically compose custom workflow validation gates, timeout thresholds, and retry logic arrays using an LLM Composer agent is **deferred** to Phase 3b.

#### Executor History Preservation

- **SYS-REQ-019:** **While** executing an assigned subtask loop, the Executor role **shall** retain short-term
  conversation history for troubleshooting, but the system's prompt injection layer **shall** narrow context focus
  strictly to the active subtask definition and its immediate validation gate failures.

### 7.6 Grounding Constraints

- errors shall fail loud unless a specific case is later identified for graceful fallback.
- Role parameter independence
  - THE SYSTEM SHALL treat prompt, model, tools, context, metadata, and response requirements as independently variable per role, and SHALL
    NOT hardcode any of these six inside logic shared across roles.
- Multi-provider, per-tier selection
  - WHEN configuring a role's model tier, THE SYSTEM SHALL allow the provider (copilot-native, Anthropic, Gemini, or local)
    to be selected independently per tier, rather than enforced globally across all tiers.

### 7.7 Workspace Command Execution Centralization

- **SYS-REQ-020 (Ubiquitous):** All workspace mutation, Git operations, and terminal command execution **shall** flow exclusively through the three core workspace functions exported from `src/workspace/index.ts`: `initializeWorkspace()`, `getGitSandbox()`, and `getExecCommand()`.
- **SYS-REQ-020a (Unwanted Behavior):** **If** any module directly imports and uses `child_process` methods (`exec`, `execSync`, `spawn`) instead of routing through the centralized workspace API, **then** the system **shall** fail code review as a violation of architectural boundary separation.
  - _Rationale:_ Centralized routing ensures unified timeout policies (GIT_TIMEOUT_MS, EXEC_TIMEOUT_MS), host-container environment abstraction, concurrency control via `GitSandbox.withLock()`, and coherent audit trails across all autonomous execution.

### 7.8 Branch-Per-Task Policy

- **SYS-REQ-021:** Each task **shall** run in a dedicated `task/<id>` git branch branched off the active trunk base branch. The system trunk branch **shall** remain untouched until human review and final merge/approval.
- **SYS-REQ-021a:** **When** a task is parked (e.g., due to a circuit breaker breach or task blocking), the system **shall** commit all existing worktree mutations to the active `task/<id>` branch, and then checkout the base branch to prepare for the next task.

### Testing workspace policy — NO REPO MUTATION (MANDATORY)

Tests MUST NOT create, persist, or mutate files or directories inside the repository working tree. To make the intent explicit and auditable:

- Tests are allowed to create ephemeral workspaces only under the operating system temporary directory (e.g., os.tmpdir()). Never create test fixtures directly under the repository root (no tmp-\*, .tmp/, test-fixtures/ in repo).
- Always create ephemeral workspaces with unique names (fs.mkdtempSync or equivalent) and clean them up in a finally block or test teardown hook.
  - do not conflate the workspace the app is managing with the workspace containing the app's code.

  - If a test needs to exercise Git operations or workspace behaviors, prefer one of:
  - invoking the centralized workspace APIs in src/workspace,
  - mock the API in src/workspace so the tests don't make any real git operations or command executions.

Rationale: This enforces SYS-REQ-020's intent (centralized workspace & Git management) and prevents accidental destructive test behavior that could mutate or delete repository data. Adopting a test helper and a defensive check protects developers and CI runners from catastrophic mistakes.

## Policy exceptions

- dev-terminal/ is an explicit development-only exception to SYS-REQ-020. It intentionally runs host processes for local development and debugging while the project runs in AI Studio mode. dev-terminal/ must be excluded from security audits and code-scanning workflows and removed before production or when AI Studio is no longer used. Any other use of `child_process` outside `src/workspace/` requires an explicit, documented exception and code-review approval.

- TODO: Remove dev-terminal/ when AI_STUDIO support is removed.
