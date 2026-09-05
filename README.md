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
- **Medium:** Task-Based Execution — The planner (expensive model) decomposes a user goal into structured tasks stored in SQLite (`pending → running → blocked | done`). This creates a hierarchy of `spec (file in git) → PBIs (derived, dependency-graphed) → tasks (SQLite, ordered within a PBI) → sessions (execution attempts)`. The executor (cheap model) receives one task at a time as a narrow directive, with each task subject to the standard gate loop. Cross-task context is preserved via a workingMemory summary — appended after each completed task and injected as a prefix to the next. Blockers filed during execution route through the resolver/escalation mechanism.
  - **Working Memory Contract Defined:**
    - (1) **Schema/Format:** Structured markdown summary tokens comprising `[Task Summary]`, `[Key Decisions]`, and `[Pending Blockers]`.
    - (2) **Size/Token Limit:** Capped strictly at 40,000 characters (approx. 8,000 tokens) to guarantee compatibility with Gemini context bounds.
    - (3) **Truncation Policy:** Handled via `enforceWorkingMemoryTruncation` (exponential decay retaining the root goal at index 0 and sliding operational cycles).
    - (4) **Persistence Strategy:** Stored in-memory per session record (`session.conversationHistory`) and synced seamlessly to the state snapshot for diagnostic auditing.
- **Low:** LLM workflow composers for dynamic subworkflows.
- **Low/Deferred:** Dedicated LLM intent-deciphering steps per prompt (unnecessary due to robust human escalation tier).

---

## Formal Requirements

The `ORCH-REQ-*` and `SYS-REQ-*` EARS-format requirements (core orchestration
constraints, boundary/agent architecture, automation enforcement, human
interruption, system topology, workspace/UI requirements, and the
`SessionWrapper` spec draft) live in `docs/system-requirements.md`. Active
follow-on work is tracked in `docs/roadmap-spec.md` (`RM-REQ-*`); the current
`SessionWrapper` tool-enablement spec (`SYS-REQ-028` family) lives in
`docs/SessionWrapper-spec.md`; build-status tiering across all of the above
lives in `docs/orchestration-ears-by-tier.md`.

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
