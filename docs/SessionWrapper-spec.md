# SessionWrapper: Tool Enablement & Cache Stability (SYS-REQ-028)

## Context

Follow-up to SYS-REQ-027k (issue #146), which stabilized the `messages` prefix
across resume by freezing `systemMessage` under `replace` mode. Investigation
established that the `tools` field sent to the model is a **separate** payload
from `messages`, is **not** stabilized by SYS-REQ-027k, and that mutating it
(e.g. via `addTools`/`removeTools` today) invalidates the KV cache regardless
of `messages` staying stable. This spec supersedes the tool-mutation and
system-message parts of SYS-REQ-027 (027a, 027a-1, 027d, 027h, 027i, 027j,
027k) with a design where the wire-level tool schema never changes after
session creation. In particular, 027h/027i's "approve iff present in `_tools`"
permission model no longer applies as written: schema presence in `tools` is
now constant regardless of enablement (SYS-REQ-028), so enablement is instead
governed by subset membership evaluated at the permission layer (SYS-REQ-028d).

---

## Requirements

- **SYS-REQ-028 (Ubiquitous):** The full set of tool schemas passed to the SDK
  in the `tools` field **shall** be fixed at `SessionWrapper` construction and
  **shall not** change for the lifetime of the session, including across every
  resume.

- **SYS-REQ-028a:** `SessionWrapper`'s constructor **shall** be the only place
  that accepts a tool list. No other method **shall** add a tool whose schema
  was not supplied at construction.

- **SYS-REQ-028a-1 (Resolved):** Built-in tools **shall** be included in the
  model's tool set by default unless explicitly excluded at construction, per
  the underlying SDK's own default behavior. "Excluding" a built-in **shall**
  mean omitting it from the construction-time tool list passed to the
  `SessionWrapper` constructor — there **shall not** be a separate runtime
  removal mechanism (e.g. an SDK `excludedTools` field set post-construction).
  This keeps built-in exclusion subject to the same construction-time-only
  rule as every other tool (SYS-REQ-028a), rather than introducing a second,
  mutable channel that could itself drift the cached prefix.

- **SYS-REQ-028b (Unwanted Behavior):** **If** `enableTools(...)` or
  `disableTools(...)` is called with a tool name not present in the
  construction-time tool list, **then** `SessionWrapper` **shall** throw
  synchronously and **shall not** apply any partial state change.

- **SYS-REQ-028c:** `enableTools(...)`/`disableTools(...)` (renamed from
  `addTool`/`removeTool`) **shall** mutate only a private "enabled subset" of
  the construction-time tool list. All tools **shall** be enabled by default
  immediately after construction.

- **SYS-REQ-028d:** Enablement **shall** be enforced exclusively through the
  `onPermissionRequest` handler. A call to a disabled tool **shall** be
  rejected at the permission layer; the tool's schema **shall** still be
  present in `tools` regardless of its enabled/disabled state (required by
  SYS-REQ-028).

- **SYS-REQ-028d-1 (Resolved):** Any SDK field that narrows which tools the
  model is *told* it may call — e.g. `availableTools` — **shall** be set once,
  to the full construction-time tool list, and **shall never** be narrowed to
  the enabled subset on any turn or resume. Narrowing this field per-turn
  reintroduces the exact hazard behind issue #146 (`resumeSession`'s
  `availableTools` narrowing regenerates the system message and busts the
  cache) that this spec exists to close — schema-freeze under SYS-REQ-028
  alone does not prevent it, since `availableTools` and the `tools` schema
  array are distinct SDK fields. Enablement narrowing happens exclusively at
  the permission layer (SYS-REQ-028d), never by changing what's declared
  available.

- **SYS-REQ-028d-2 (Resolved):** The SDK's own auto-generated tool
  descriptions (e.g. `customize` mode's `tool_instructions` section) **may**
  describe a disabled built-in tool as generically available — confirmed in
  practice (OpenRouter request logs show default built-in descriptions
  present regardless of `SessionWrapper`'s enabled subset). This is expected
  and **not** treated as a defect: the SDK-native text is never authoritative
  for enablement. SYS-REQ-028i's per-turn notice, which states the full
  currently-enabled subset (not just deltas) on every turn including the
  first, is the sole authoritative, model-facing signal of what's actually
  callable, and is trusted to supersede any conflicting SDK-native
  description in the model's own reasoning.

- **SYS-REQ-028e:** `SessionWrapper` **shall** own its `CopilotSession`
  instance internally and **shall** perform resume on the caller's behalf.
  No caller **shall** call `client.resumeSession(...)` directly.

- **SYS-REQ-028f:** Constructing a new `SessionWrapper` **shall** always result
  in `client.createSession(...)` — never a resume. Resuming an existing
  session **shall** only happen through re-obtaining/reusing the
  `SessionWrapper` instance associated with that session (mechanism for
  cross-process reconstruction is out of scope for this spec — see Open
  Questions).

- **SYS-REQ-028g:** On resume, `SessionWrapper` **shall** pass to the SDK
  `onPermissionRequest` plus only whichever fields the SDK actually requires
  to be present for a correct resume, and any such field **shall** be sent
  byte-identical to what was sent at creation. `model` and any `_baseConfig`
  field **shall** be omitted, since none of them may legitimately differ
  across resume under this spec. Verified against the live SDK (not just a
  mocked double): `tools`, `availableTools`, and `systemMessage` all fall
  into the required-by-the-SDK category and **must** also be resent on every
  resume. For `tools`/`availableTools`: the SDK does not retain
  handler-backed custom tools across `resumeSession` the way it retains
  built-ins by name; omitting them makes the SDK itself believe a
  construction-time custom tool no longer exists and short-circuit with its
  own "does not exist" rejection, which never reaches `onPermissionRequest`
  and so silently defeats SYS-REQ-028d enforcement for custom tools. For
  `systemMessage`: `resumeSession` does not inherit it from the session
  being resumed (issue #208) -- omitting it silently falls back to the SDK's
  default `copilot-cli` system prompt for the rest of the turn, discarding
  SYS-REQ-028h's frozen prompt without any error. `autoApproveAll: false`
  **shall** also be passed explicitly on resume: `boundary.ts`'s
  `CopilotClient.resumeSession` override defaults `autoApproveAll` to `true`
  whenever it's omitted, which swaps in its own always-approve handler and
  silently discards whatever `onPermissionRequest` was passed, defeating
  SYS-REQ-028d on every resumed turn.

- **SYS-REQ-028h:** `systemMessage` **shall** be configured in `customize`
  mode (superseding SYS-REQ-027k's `replace` mode). `SessionWrapper` **shall
  not** maintain a hand-authored frozen baseline of the full system message.

- **SYS-REQ-028i:** `SessionWrapper` **shall** inject per-turn text stating
  the currently-enabled tool subset on every turn, including the first —
  not only on turns following a mutation.

- **SYS-REQ-028j (Unwanted Behavior):** **If** any module other than
  `SessionWrapper` reads or writes the enabled-tool subset, the tool schema
  list, or the `CopilotSession` instance directly, **then** this **shall**
  be treated as a spec violation (carries forward SYS-REQ-027/027e's
  single-owner intent).

- **SYS-REQ-028k (Resolved):** Enablement state **shall** be evaluated at the
  moment each individual `onPermissionRequest` call is handled, not once per
  turn. **If** `disableTools(...)` is called after a tool's permission check
  for the current call has already been evaluated, **then** that in-flight
  call **shall** be unaffected — only a *subsequent* call to that tool, whose
  permission check runs after the mutation, **shall** see it denied. This
  follows directly from SYS-REQ-028d (enablement enforced exclusively at the
  permission layer, per-call) and requires no additional bookkeeping beyond
  reading the current enabled subset fresh inside each `onPermissionRequest`
  invocation — the same per-call-fresh-read pattern SYS-REQ-027i already
  established. Resolves former Open Question 2.

- **SYS-REQ-028l (Resolved):** The per-turn enablement text (SYS-REQ-028i)
  **shall** be prepended to the outgoing user turn's prompt, never folded
  into `systemMessage` or any other system-adjacent block. This is forced by
  SYS-REQ-028g/h: `systemMessage` must stay byte-identical across every
  resume, so text that changes turn-to-turn (or must appear on every turn
  per 028i) cannot live there without either going stale or busting the
  cached prefix — the exact hazard this spec exists to close. Mirrors the
  existing `buildSessionUpdateNotice` pattern (append-only, never rewrites
  prior turns). Resolves former Open Question 1.

---

## Verified by test (fixture-backed, not real CAPI)

- `messages` is a byte-identical prefix across resume when the tool list and
  system message mode are held constant (re-confirms SYS-REQ-027k still
  holds under `customize`).
- The `tools` field is *not* stable across resume when tools are
  added/removed via the pre-028 `addTool`/`removeTool` mechanism — appending
  a tool changes the bytes of that field on the next request.
- Under `customize` mode, system message text was identical across two calls
  with an identical tool list but opposite `onPermissionRequest` decisions
  (allow vs. deny) — confirms permission enforcement is out-of-band from the
  cached prefix, which SYS-REQ-028d depends on.
- Under `customize` mode with the test fixture, the SDK's `tool_instructions`
  section did not enumerate custom tool names/descriptions at all. This
  motivates SYS-REQ-028i (per-turn injected enablement text is the only
  model-facing signal of what's currently callable)

---

## External verification (Anthropic API docs, not SDK-internal)

Since our session infra reaches the model via BYOK/CAPI relay to Anthropic,
the fixture-backed results above were cross-checked against Anthropic's
documented prompt-caching behavior directly, independent of the
`@github/copilot-sdk` layer:

- Confirmed: the cached prefix is hashed in the order **tools, then system,
  then messages** — `tools` is its own cache segment upstream of `system`/
  `messages`, not folded into the messages array. This is the mechanism
  underpinning the core premise of this spec (tool-schema mutation busts the
  KV cache independently of `messages` staying stable).
- Confirmed: cache lookups are prefix-based and byte-exact — any change
  anywhere in or before a cached segment invalidates the cache from that
  point onward for the *next* request. Nothing "partially" survives a
  `tools` mutation; everything downstream of it (system message, full
  conversation) also misses.
- Caveat: `@github/copilot-sdk` itself does not currently expose prompt-cache
  hit/miss telemetry (open upstream issue, unresolved as of this writing) —
  `cache_read_tokens`/`cache_write_tokens` on `assistant.usage` events are
  defined but always report `0`. This doesn't contradict the design (caching
  plausibly still happens at the Anthropic API layer beneath the SDK), but it
  means we cannot confirm cache-hit behavior via SDK telemetry against live
  CAPI — the fixture-backed tests above remain the primary verification
  mechanism for this spec until that upstream gap closes.

---

## Test coverage implied by this spec

Tests are spec enforcement, not just illustration — each item below should be
a direct, nameable assertion, not general-purpose fuzzing.

1. **Schema immutability (028, 028a):** construct with tool list `[A, B]`;
   assert `tools` sent to `createSession` and to every subsequent
   `resumeSession` is byte-identical, including after `enableTools`/
   `disableTools` calls in between.
2. **Construction-only entry point (028a):** assert there is no public method
   other than the constructor that can cause a tool absent at construction to
   appear in `tools` on any later call.
3. **Built-in default-inclusion / omission-only exclusion (028a-1):** assert
   a built-in omitted at construction never appears in `tools`/`availableTools`
   on create or resume, and that no method accepts a post-construction
   exclusion list.
4. **Unknown-tool-name rejection is atomic (028b):** call `enableTools('A',
   'unknown')`; assert a synchronous throw and that `A`'s enabled state is
   unchanged from before the call (no partial mutation).
5. **Default-enabled state (028c):** assert every construction-time tool is
   enabled immediately after construction, before any `enableTools`/
   `disableTools` call.
6. **Permission-layer-only enforcement (028d):** call a disabled tool; assert
   rejection originates from `onPermissionRequest`, and separately assert its
   schema is still present in the `tools` payload for that same call.
7. **`availableTools` never narrows (028d-1):** disable a subset of tools;
   assert the `availableTools` field (or equivalent) sent on the next turn is
   still the full construction-time list, not the enabled subset.
8. **SDK-native description does not gate behavior (028d-2):** with a
   built-in disabled, assert a call to it is still rejected regardless of
   whether the SDK's own generated tool description text mentions it —
   i.e. the permission layer's decision, not the SDK's text, is what's
   asserted.
9. **Sole ownership (028e, 028j):** assert no test double or production
   module calls `client.resumeSession`/`createSession` directly, or reads/
   writes the enabled-subset or tool-schema state, other than through
   `SessionWrapper`'s own public surface (lint rule + a unit test asserting
   the private fields aren't externally reachable).
10. **Construction always creates (028f):** assert the first call from a new
    `SessionWrapper` instance is always `createSession`, never `resumeSession`,
    regardless of any external session ID the caller might supply.
11. **Resume payload minimality (028g):** on a second `sendAndWait()` call,
    assert the `resumeSession` call includes only `onPermissionRequest`,
    `autoApproveAll: false`, and the SDK-mandatory `tools`/`availableTools`/
    `systemMessage` fields — never `model` or any `_baseConfig` field — and
    that `tools`/`availableTools`/`systemMessage` are byte-identical to the
    values sent at creation.
12. **`systemMessage` mode (028h):** assert `systemMessage` is sent with
    `mode: 'customize'`, and that no hand-authored full-baseline string is
    constructed or maintained by `SessionWrapper` itself.
13. **Per-turn enablement notice, every turn (028i, 028l):** assert the
    notice is present and prepended to the outgoing user turn on the *first*
    turn (no mutation yet occurred) as well as after a mutation; assert it is
    never folded into `systemMessage`.
14. **Mid-turn mutation race (028k):** issue a tool call, capture that its
    permission check has run, call `disableTools` on that same tool before
    the call completes, and assert the in-flight call is unaffected while a
    *subsequent* call to the same tool on the next turn is denied.

---

## Open Questions

1. Cross-process resume: if a `SessionWrapper` instance is reconstructed in a
   new process to resume an existing session (SYS-REQ-028f), the caller must
   re-supply a construction-time tool list identical to the one originally
   used. `SessionWrapper` cannot verify this identity against what the SDK
   actually has cached — this is a caller responsibility that should be
   documented explicitly, possibly enforced via a checksum/hash stored
   alongside session metadata.

_Former Open Questions 1 (enablement-text placement) and 2 (mid-turn
`disableTools` race) are resolved above as SYS-REQ-028l and SYS-REQ-028k
respectively._
