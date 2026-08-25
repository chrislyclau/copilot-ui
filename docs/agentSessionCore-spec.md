# agentSessionCore: Session Unit Extraction (SYS-REQ-029)

## Context

`SessionWrapper` (SYS-REQ-026/027/028) is the sanctioned owner of SDK
session lifecycle and tool enablement: schemas are frozen at construction
(SYS-REQ-028/028a), and enablement is a private subset mutated only by
`enableTools`/`disableTools` and enforced exclusively inside
`SessionWrapper`'s own `onPermissionRequest` (SYS-REQ-028d, 028j -- no other
module may read or write enablement state).

Three present-day call sites construct an exec tool and a permission/lock
decision around it independently of each other and of `SessionWrapper`'s own
enablement mechanism: `scripts/verify-run-terminal-docker.ts`,
`src/utils/auditorHelper.ts`, and `src/orchestrator/gateLoop.ts` (the last of
these also wires a second tool, `run_tests`, through the same lock decision).
Two of the three currently branch on session state *inside the tool
handler's own body* rather than through `enableTools`/`disableTools`, which
duplicates a decision `SessionWrapper` is already positioned to enforce and
opens a path for that decision to drift from the single-owner model
SYS-REQ-028j establishes. This spec extracts a single unit,
`src/agentSessionCore/`, that both parties -- schema construction and
lock-state-driven enablement -- route through. The call-site migration and
gateLoop follow-up are tracked entirely on their own issues (#416, #417),
not in this spec: this spec covers only the unit's own target behavior,
independent of who has adopted it. It does not modify `SessionWrapper`
itself or supersede any SYS-REQ-026/027/028 requirement.

This spec's own current-repo details (file names, line numbers, "as of this
writing" facts) are confined to this Context section and its footnotes.
Requirements below describe target behavior only; they are not a record of
what any file presently does, and should read the same regardless of how the
current call sites happen to be implemented on a given day.

---

## Decisions carried from handoff (not re-litigated here)

- **Directory: `src/agentSessionCore/`.**
- **No file moves** of existing shared modules into it -- they are imported,
  not relocated.
- **Build approach: hotswap** -- built and tested standalone before any
  existing call site is touched; migration is a separate, later step.
- **Lint enforcement of the new boundary is a migration-time task**, not
  part of the extraction step.

---

## Requirements

### Composition

- **SYS-REQ-029:** `src/agentSessionCore/` shall be the sole module tree
  responsible for (a) constructing agent-executable tool schemas for use
  with `SessionWrapper`, and (b) deciding, per outgoing turn, which of those
  tools are enabled, for every consumer that adopts it.

- **SYS-REQ-029a:** `src/agentSessionCore/` shall provide access to
  `SessionWrapper`, the shared workspace-exec accessor, the
  orchestration-session-state query, and the forced-tool-turn helper by
  import, without relocating their defining modules.

- **SYS-REQ-029b:** `src/agentSessionCore/` shall expose exactly one factory
  that produces a tool definition for the containerized shell-exec tool.

- **SYS-REQ-029c:** `src/agentSessionCore/` shall expose a session factory
  that accepts an arbitrary set of tool definitions (not only the shell-exec
  tool) and returns a `SessionWrapper` instance with that full set registered
  as its construction-time tool list (SYS-REQ-028a). A consumer that needs a
  second, non-exec tool enabled under the same lock policy shall be able to
  register it through this same factory rather than composing its own
  session outside the unit.

- **SYS-REQ-029d:** The shell-exec tool's handler shall perform its
  working-directory traversal check and output-sanitization exactly once,
  shared by every caller of SYS-REQ-029b's factory, regardless of which
  lock policy (SYS-REQ-029e) or output-delivery mode (SYS-REQ-029h) that
  caller selects.

### Orchestration-lock as enablement, not a parallel gate

- **SYS-REQ-029e:** `src/agentSessionCore/` shall expose exactly one
  mechanism for making a tool's availability conditional on live
  orchestration-session state: driving `SessionWrapper.enableTools`/
  `disableTools` for that tool before each turn is sent, so that rejection
  of a disabled tool's call is enforced by `SessionWrapper`'s own
  `onPermissionRequest` (SYS-REQ-028d), not by a second check inside the
  tool's own handler body. A tool handler constructed by this unit shall not
  itself read orchestration-session state to decide whether to execute.

- **SYS-REQ-029f:** A consumer of SYS-REQ-029c's session factory shall
  select, per registered lock-eligible tool and with no default value, one
  of:
  - **locked** -- before each turn, the unit shall query current
    orchestration-session state and call `enableTools`/`disableTools`
    accordingly for that tool.
  - **unlocked** -- the tool shall remain enabled for the lifetime of the
    session, unaffected by orchestration-session state.

  Omitting this selection for a lock-eligible tool shall be a compile-time
  error.

- **SYS-REQ-029g (Unwanted Behavior):** If a tool registered as **locked**
  is called while orchestration-session state indicates it should be
  disabled, then the call shall be rejected at `SessionWrapper`'s permission
  layer with a message identifying the required condition, and the tool's
  schema shall still be present in the session's `tools` payload
  (consistent with SYS-REQ-028/028d).

- **SYS-REQ-029h:** Delivery of a tool call's output back to any external
  stream (e.g. a caller-supplied write-back callback) shall be an
  independently selectable option of SYS-REQ-029c's factory, orthogonal to
  the lock selection in SYS-REQ-029f -- a consumer shall be able to choose
  any combination of {locked, unlocked} × {streamed, unstreamed} without
  requiring a bespoke handler outside this unit.

- **SYS-REQ-029i:** Each consumer's lock selection (SYS-REQ-029f) shall be
  accompanied, at the call site, by a short rationale for that choice. This
  requirement is about the decision being visible and deliberate at every
  call site, not about which value is chosen.

---

## Test coverage implied by this spec

1. **Tool-agnostic factory (029c):** register a non-exec tool alongside the
   shell-exec tool through the same factory; assert both appear in the
   resulting `SessionWrapper`'s construction-time tool list.
2. **Shared handler logic (029d):** assert the traversal check and output
   sanitization behave identically across every {lock, delivery} combination
   the factory supports.
3. **No handler-internal gating (029e):** assert the shell-exec tool's
   handler function never reads orchestration-session state itself; assert
   rejection of a disabled call originates from `SessionWrapper`'s
   `onPermissionRequest`, not from the handler.
4. **Lock is mandatory, no default (029f):** a compile-only test asserting
   omission of the lock selection for a lock-eligible tool fails to build.
5. **Locked rejects, unlocked doesn't (029g):** with a tool registered
   **locked** and orchestration-session state indicating disablement, assert
   the call is rejected and the schema remains present in `tools`; with the
   same tool **unlocked**, assert the call succeeds under identical session
   state.
6. **Lock and delivery are independent (029h):** exercise all four
   {locked, unlocked} × {streamed, unstreamed} combinations; assert each
   behaves correctly on both axes independently.

Migration-completion assertions (sole schema constructor once migrated,
live-container pass/fail parity across migration) are acceptance criteria
for issue #416, not test coverage for this extraction spec.

---

## Open Questions

1. **Whether the orchestration-session-state query itself should physically
   move** into `src/agentSessionCore/` rather than being imported from its
   current location. Flagged as a separate, independently reviewable step
   if/when it happens -- not resolved by this spec.
2. **`SessionWrapper.adopt()`** remains an unresolved escape hatch pending
   owner sign-off. If any migrated consumer needs to adopt an
   already-created session rather than construct one fresh, SYS-REQ-029c's
   factory may need an adopt-based variant -- not decided here.
3. **Per-turn lock re-evaluation cost (029f "locked"):** re-querying
   orchestration-session state and calling `enableTools`/`disableTools`
   before every turn is cheap for the current in-memory session-state model,
   but this spec does not commit to that remaining true if the underlying
   state query becomes more expensive (e.g. moves off-process). Worth
   revisiting if that query's cost profile changes.
