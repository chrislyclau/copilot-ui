# Project Summary: Copilot SDK UI Agent.

### What It Is

Express + Vite/React app wrapping `@github/copilot-sdk`. Streams real SDK events via SSE (POST + `ReadableStream` reader). Gemini models accessed via OpenAI compatibility layer (`[generativelanguag[...]


---

### Design Principles (varying degree of certainties)

- **High:** Deterministic gates (test/lint/audit) as retry loops with limits.
- **High:** Expensive model as planner, cheap model as executor.
- **High:** Role-based model assignment supporting heterogeneous providers per loop (Planner, Executor, Auditor).
- **High:** **Executor Narrow Focus with Cumulative Working Memory** — The executor retains active conversational history to troubleshoot errors comparatively, but the prompt injection layer nar[...]
- **High:** Favor automation over human checkpoints (human effort is the premium resource; UI serves as an ambient notification surface, not an interruption screen).
- **High:** Structured output always via tool calls, never prompted raw JSON text blocks.
- **Medium:** Automated decision logging via immutable runtime audit trail.
- **Medium:** Persistent, versioned task decomposition artifacts rather than throwaway conversational breakdowns.
- **Medium:** Task-Based Execution — The planner (expensive model) decomposes a user goal into a versioned tasks.md artifact via tool call. The executor (cheap model) receives one task at a time[...]
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
- **ORCH-REQ-004 (Unwanted Behavior):** **If** the active operational state requires a workspace mutation or state transition, **while** the agent response contains only plain text with no valid t[...]

### 1.2 Memory Optimization & Truncation

- **ORCH-REQ-005 (Unwanted Behavior):** **If** the cumulative character footprint of intermediate tool logs crosses 40,000 characters, **then** the Orchestrator Server shall execute an exponential[...]

### 1.3 Safety Circuits

- **ORCH-REQ-006 (Unwanted Behavior):** **If** the autonomous execution loop reaches `MAX_LOOP_CYCLE_CEILING = 10`, **then** the Orchestrator Server shall execute a hard circuit breaker, emit a st[...]

---

## 2. Boundary Context Enforceability & Agents Architecture

### 2.1 The Code Auditor & Spec-Gate Isolation Matrix

- **ORCH-REQ-007 (Event-Driven):** **When** an evaluation gate requires an out-of-band audit, the Gate Pipeline shall instantiate an ephemeral, distinct runtime context for the designated Auditor [...]

#### Mode A: Absolute Statelessness

- **ORCH-REQ-007a (Configurable Mode):** **Where** strict stateless evaluation is configured for a gate, the Orchestrator Server shall provide the Auditor instance with only the active workspace d[...]
- _Requirement Stability:_ **Stable — both modes are supported and configurable per gate/session, not a one-time architecture choice (see ORCH-REQ-007).**

#### Mode B: Ephemeral Summary Handoff

- **ORCH-REQ-007b (Configurable Mode):** **Where** stateful tracking is configured for a gate, the Orchestrator Server shall extract a single, machine-generated summary token from the Auditor's ow[...]
- _Requirement Stability:_ **Stable — both modes are supported and configurable per gate/session, not a one-time architecture choice (see ORCH-REQ-007).**
- _Architectural Design Decision:_ If Mode B is selected during implementation, the injected token must be strictly limited to a declarative list of previously rejected code states to prevent the [...]
- _Scope Note:_ This summary token concerns only the Auditor's continuity with its own prior audit verdicts. It is unrelated to, and does not affect, ORCH-REQ-008's isolation of the Auditor from t[...]

- **ORCH-REQ-008 (State-Driven):** **While** evaluating an Executor's code changes for bugs or syntax errors, the Code Auditor model context shall remain strictly blind to the Executor's historica[...]

### 2.2 The Spec-Gate Auditor Role

- **ORCH-REQ-009 (Event-Driven):** **When** a deterministic gate execution fails or an Executor completes a task blueprint, the Gate Pipeline shall instantiate a dedicated, out-of-band Spec-Gate A[...]
- **ORCH-REQ-010 (State-Driven):** **While** evaluating workspace modifications, the Spec-Gate Auditor shall accept only the raw code changes (diffs) and the primary technical design specification[...]
- **ORCH-REQ-011 (Unwanted Behavior):** **If** the Spec-Gate Auditor detects a structural deviation between the workspace mutations and the rules defined in the specification file, **then** it sha[...]

---

## 3. Automation Enforcement (Human-Out-Of-The-Loop)

### 3.1 Command Execution Autonomy

- **ORCH-REQ-012 (Ubiquitous):** The Orchestrator Server shall execute all workspace mutation, file system, and terminal commands automatically without pausing for client-side permission or manual[...]
- **ORCH-REQ-013 (Unwanted Behavior):** **If** an active agent generates a command execution string, **then** the Verification Gate shall act as an automated logging pass-through layer that auto-a[...]

### 3.2 Host-Isolation & Risk Absorption

- **ORCH-REQ-014 (Ubiquitous):** The execution loop shall rely exclusively on host-worktree isolated Docker sandboxes (derived dynamically from a host-path directory hash) and Git-based version ro[...]

---

## 4. Human-Interruptible Upgrades (Asynchronous Interception)

### 4.1 Real-Time Specification Patching (Abrupt Abort & Re-Prompt)

- **ORCH-REQ-015 (Event-Driven):** **When** a user updates the primary design specification via the UI while an agent execution loop is running, the Orchestrator Server shall immediately abort the[...]
- **ORCH-REQ-016 (State-Driven):** **While** re-invoking the execution loop immediately after an abort event, the Orchestrator Server shall inject a system message containing the updated specifica[...]

### 4.2 Asynchronous Panic Break (Loop Abort)

- **ORCH-REQ-017 (Event-Driven):** **When** a user triggers a manual `PANIC_STOP` signal from the UI timeline, the Orchestrator Server shall immediately issue a hard termination signal (`SIGKILL`[...]
- **ORCH-REQ-018 (State-Driven):** **While** in a panicked or aborted state, the Orchestrator Server shall persist the session status as `MANUAL_INTERVENTION_REQUIRED`, reject all incoming automa[...]


---

## 5. System Topology & Operational Pillars

### 7.1 Abstract Provider Registry

To guarantee the platform is strictly model-agnostic, all core orchestrator modules communicate exclusively with an abstract provider interface. This layer decouples internal execution logic from[...]

- **Payload Normalization:** Upstream adapters dynamically scrub structural parameters that break alternative strict OpenAI-compatible or Anthropic-compatible endpoints (e.g., stripping proprieta[...]
- **Model Tier Mapping:** Models are registered centrally and bound to generalized processing profiles (_Baseline, Intermediate, Advanced_) rather than specific commercial brand names.

### 7.2 Host-Container Volume Handoff & Git Guard Rail

All workspace management is handled via the src/workspace code, to which changes are not permitted without a discussion.

### 7.3 Strict Architectural Layer-Boundary Separation

To maintain portability and resilience across varying container virtualization environments, the frontend application must remain completely decoupled from host infrastructure constraints and exe[...]

- **Frontend Blindness:** The user interface displays purely high-level verification outcomes and is strictly forbidden from maintaining state hooks, checkboxes, or payload parameters related to [...]
- **Transparent Server Routing:** The server-side execution pipeline must handle environment diagnostics out-of-band using `DIAGNOSTIC_MODE` and local capabilities detection. When container engin[...]

---

## 6. Streamlined "Cockpit" & Turn History Layout


```
┌───────────────────────────────────────┬────────────────────────[...]
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
└───────────────────────────────────────┴────────────────────────[...]

```

### 6.1 Left Column: The Verification Frame

- **AI Studio File Badges:** Displays a flat list of modified file paths rendered as high-contrast chips displaying numerical insertions and deletions (e.g., `src/server.ts +42 -12`).
- **Turn Diff Trigger:** Features a prominent **"View Turn Diff"** button. Clicking this launches a full-screen unified diff overlay showing every code modification executed across the active Git[...]
- **Source of Truth:** The Verification Frame is decoupled from the selection state of the Turn History Sidebar. It computes file chips and unified diff structures directly from the workspace's a[...]

### 6.2 Right Column: The Turn History Sidebar


- **Milestone Grouping:** Telemetry and background tool logs are hidden by default. Turns pull their text labels dynamically from the Planner's task decomposition artifacts emitted via structured[...]
- **Action Breadcrumbs:** Clicking an item expands a read-only sequential breakdown of agent micro-actions (e.g., `Planner: Generated tasks`, `Composer: Assembled blueprint`).
- **Gate Failure Isolation:** Clicking a failed gate node within the active breadcrumb expands inline to display the raw `stderr` / failure buffer output. **This inline expansion acts as the sing[...]

---

## 7. Formal System Requirements (EARS)

### 7.1 Workspace & Environment Integration

- **SYS-REQ-001:** The system **shall** not manage docker container's lifecycle. src/workspace/dockerRunner.ts **shall** receive the container's name via an environment variable and assumes the w[...]

- **SYS-REQ-004:** The system **shall** map external model definitions to generic API handlers using an abstract provider adapter layer.
- **SYS-REQ-005:** The system **shall** strip unsupported parameters from payloads before sending requests to non-native generic compatibility layers.
- **SYS-REQ-005a:** The browser-side application interface **shall not** track, transmit, or render parameters, options, or controls specific to container virtualization engines (such as Docker b[...]
- **SYS-REQ-005b:** The backend owns all state and all state transitions. The frontend may act as a thin, user-initiated trigger (e.g. a button that fires a single request) but must not drive, po[...]

### 7.2 Verification UI & View Turn Diff

- **SYS-REQ-006:** The system **shall** display a flat list of modified file paths as visual chips showing lines added and removed in the Verification Frame computed from the current active Git H[...]
- **SYS-REQ-007:** The system **shall** provide an explicit "View Turn Diff" button adjacent to the modified file list.
- **SYS-REQ-008:** **When** the user clicks the "View Turn Diff" button, the system **shall** launch a full-screen unified diff overlay displaying the code changes within the specific Git commit [...]

### 7.3 Turn History & Interaction Models

- **SYS-REQ-009 (Turn Structure Refactor):** The system **shall** group streaming telemetry events inside parent Turn data containers initialized by the orchestrator core loop, replacing the un-g[...]
- **SYS-REQ-009a (Explicit SHA Binding):** **When** a Turn block concludes with a passing status, the server **shall** emit a completion payload containing the unique Git commit SHA tied directly[...]
- **SYS-REQ-010:** **When** a turn is clicked, the Turn History Sidebar **shall** expand to show a read-only chronological sequence of agent action breadcrumbs.
- **SYS-REQ-011:** **When** a failed gate node within an action breadcrumb sequence is clicked, the system **shall** expand the item inline to render the raw terminal `stderr` failure buffer.

### 7.4 Immutable Checkpoint Mechanics

- **SYS-REQ-012:** The system **shall** make a "Restore Checkpoint" action button available for each completed item inside the Turn History Sidebar.
- **SYS-REQ-013:** **While** an autonomous workflow execution run is active, the system **shall** disable and lock all "Restore Checkpoint" action buttons.
- **SYS-REQ-014 (Forward-Moving Restoration):** **When** a user triggers "Restore Checkpoint" outside of an active execution run, the system **shall** pass the specific Turn's bound commit SHA to[...]
- **SYS-REQ-015 (Dynamic History Append Naming):** The system **shall** commit the resulting working tree delta using a clear, task-descriptive commit label format (`Restore to Checkpoint: [Origi[...]
  - _Immutability Constraint:_ Git history is append-only. Restoration does **not** rewind, reset, or mutate any existing commits — it applies the target state as a new forward commit on top of[...]

### 7.5 Core Loop & Agent Scopes

#### Pre-Flight Clarity Gate

- **SYS-REQ-016:** **When** a user enters a top-level technical goal, the system **shall** run the Ambiguity Checker Agent as a pre-flight validation pass.
- **Scope Note:** The Ambiguity Checker operates strictly at the goal/specification level to confirm alignment and prevent structural contradictions before the orchestrator core launches. It does[...]
- **SYS-REQ-017:** **If** the Ambiguity Checker Agent returns a clarity coefficient score lower than `0.85`, the orchestrator **shall** halt execution, block the pipeline, and surface the itemize[...]
  - _Implementation Gap:_ The method for computing the clarity coefficient, the Ambiguity Checker's return schema, and the structure of the checklist surfaced to the user are intentionally left t[...]

#### Dynamic Workflow Composition [DEFERRED / VOLATILE]

- **SYS-REQ-018:** The system capability to dynamically compose custom workflow validation gates, timeout thresholds, and retry logic arrays using an LLM Composer agent is **deferred** to Phase 3[...]

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

- **SYS-REQ-020 (Ubiquitous):** All workspace mutation, Git operations, and terminal command execution **shall** flow exclusively through the three core workspace functions exported from `src/wor[...]
  
- **SYS-REQ-020a (Unwanted Behavior):** **If** any module directly imports and uses `child_process` methods (`exec`, `execSync`, `spawn`) instead of routing through the centralized workspace API,[...]
  - _Rationale:_ Centralized routing ensures unified timeout policies (GIT_TIMEOUT_MS, EXEC_TIMEOUT_MS), host-container environment abstraction, concurrency control via `GitSandbox.withLock()`, a[...]

---

## Policy exceptions

- dev-terminal/ is an explicit development-only exception to SYS-REQ-020. It intentionally runs host processes for local development and debugging while the project runs in AI Studio mode. dev-terminal/ must be excluded from security audits and code-scanning workflows and removed before production or when AI Studio is no longer used. Any other use of `child_process` outside `src/workspace/` requires an explicit, documented exception and code-review approval.

- TODO: Remove dev-terminal/ when AI_STUDIO support is removed. Owner: @chrislyclau.
