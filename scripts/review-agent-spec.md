# PR Review Agent — Requirements Spec

Format: [EARS](https://alistairmavin.com/ears/) (Easy Approach to Requirements Syntax).
Scope: `scripts/review-pr.ts` and its supporting modules (`reviewState.ts`, `diffFilter.ts`,
`src/config/tools.ts`). Single-repo consumer — no multi-tenant/override mechanism required.

Legend: **U** = Ubiquitous, **E** = Event-driven, **S** = State-driven, **O** = Optional
feature, **UB** = Unwanted behavior.

**Status note:** This document currently leads the implementation, not describes it. In
particular, §2.1 (file-first context delivery), §6.2 (marker cleanup — removal of
`PersistedBlockingFinding`/`blockingFindings`), and §6.4 (comment-history-as-file) are not yet
enacted in `review-pr.ts`/`reviewState.ts` as of this revision. This spec is the target those
modules should be brought into compliance with, not a record of current behavior.

---

## 1. Input Resolution

- **U-1.1** The system shall require `PR_BASE_SHA`, `PR_HEAD_SHA`, and `PR_NUMBER` environment
  variables to run, and shall exit with an error if any is missing.
- **E-1.2** When a previous review state exists and its `lastReviewedSha` is reachable and is an
  ancestor of `PR_HEAD_SHA`, the system shall compute an incremental diff using
  `lastReviewedSha..headSha`.
- **E-1.3** When no previous review state exists, or the previous `lastReviewedSha` is
  unreachable, or is not an ancestor of `headSha`, the system shall fall back to a full diff
  using `baseSha...headSha`.
- **E-1.3.1** When a previous review state exists and its `lastReviewedSha` is equal to
  `headSha`, the system shall treat this as nothing-to-review (there is no new head commit since
  the last review) and shall exit without posting a comment, per UB-1.4 — it shall NOT fall
  through to E-1.3's full-diff path, since a full diff against an unchanged head is non-empty and
  would otherwise bypass UB-1.4's bail-out, reposting a duplicate full review on every re-run
  that targets an unchanged head (e.g. a manual workflow re-run).
- **UB-1.4** If the resolved diff is empty, the system shall log that there is nothing to review
  and shall exit without posting a comment.

## 2. Context Assembly

- **U-2.1** The system shall make PR context available to the model as separate, individually
  labeled artifacts rather than a single undifferentiated prompt block. Delivery is **file-first**:
  each context source is written to disk under a scratch directory (e.g. `.review-context/`) in
  the agent's working tree, and the model is given tool access (shell) to read whichever files it
  judges relevant, rather than having all context concatenated into the prompt string. The prompt
  itself is reduced to a short pointer describing what's available and where.
- **U-2.1.1** The system shall write a manifest file (e.g. `.review-context/README.md`) listing
  each context file present and a one-sentence description of its purpose, so the model does not
  have to infer file intent from filename alone.
- **U-2.1.2** The diff artifact shall be a standard unified diff (`.patch`), unmodified by
  markdown fences or inline commentary, so it parses the way any diff the model has seen in
  training does.
- **O-2.1.3** The diff artifact may be preceded by a `git diff --stat`-style file-list summary,
  so the model can decide which files warrant closer reading before consuming the full patch.
  This matters most on large diffs; the system may omit it below some size threshold.
- **O-2.2** Where PR title, description, or linked-issue metadata is available, the system may
  write it to its own labeled file (e.g. `pr-meta.md`) rather than concatenating it with the
  diff. If no description is present, the system shall emit an explicit placeholder (e.g.
  `_No description provided._`) rather than an empty or missing file.
- **U-2.3** The system shall make `AGENTS.md` and `README.md` available to the model, if present
  at the repo root, as compliance/standards context, and shall instruct the model to treat their
  content as the basis for consistency/standards findings. These files shall be read in place
  from the checkout rather than copied into the scratch context directory, so they cannot go
  stale relative to the actual repo state and remain fully greppable alongside the rest of the
  repo. Their absence is not an error — this is best-effort context, not a hard requirement.
- **O-2.4** The system may write the commit messages for the commits included in the resolved
  diff range (§1) to their own labeled file (e.g. `commits.md`), one entry per commit with its
  short sha and full message. Commit messages often carry author intent that isn't recoverable
  from the diff alone (e.g. what a fix was targeting, or why a change was made), which is useful
  context both for the initial review and, in incremental mode, for judging whether a later
  commit's stated intent matches what §6.6–6.8 need to reason about resolution. This file shall
  reflect only the commits in the currently resolved range (full or incremental), not the PR's
  entire commit history, to avoid re-surfacing intent context already consumed in a prior run.

## 3. Finding-Admission Gate

- **U-3.1** The system shall instruct the model that a finding may only be reported when the
  model can answer all of the following:
  1. Where does the issue occur?
  2. Why is it a problem?
  3. How did this change introduce or expose it?
  4. What input, state, or execution path would trigger it?
- **UB-3.2** If the model cannot answer all four questions for a candidate issue, the system shall
  instruct the model not to report it.
- **U-3.3** The system shall instruct the model to prefer one well-evidenced finding over multiple
  speculative ones, and to merge closely related findings into a single finding.

## 4. Scope Rules

- **U-4.1** The system shall limit findings to changed lines, changed blocks, or behavior directly
  affected by the changed code.
- **U-4.2** The system shall define "directly affected" to include: touched callers/callees,
  changed contracts, changed data flow, and tests that should reasonably change because of the
  modified behavior.
- **UB-4.3** The system shall instruct the model not to raise cleanup suggestions for unrelated
  pre-existing code.
- **UB-4.4** The system shall instruct the model not to raise issues against pre-existing code
  unless the current PR newly breaks, exposes, or worsens that code path.
- **S-4.5** While the PR consists primarily of code movement/refactoring, the system shall
  instruct the model to limit findings to newly introduced bugs, regressions, or meaningful
  performance problems.
- **UB-4.6** The system shall instruct the model not to raise style/preference findings unless
  they create a real readability, consistency, or maintenance problem, or violate an established
  repo standard.

## 5. Finding Classification

- **U-5.1** Each finding shall carry a `severity` of `blocking`, `suggestion`, or `nit`.
- **O-5.2** Each finding may carry an optional `category` of `bug`, `security`, `performance`,
  or `style`, independent of `severity`.
- **U-5.3** Each finding shall carry `file`, optional `line`, and `message`.
- **U-5.4** The system shall instruct the model to keep each finding's `message` concise (target:
  under ~150 words) unless a code snippet is necessary for clarity.
- **O-5.5** Each finding may carry an optional `status` of `new`, `still-open`, or `resolved`,
  used to render §7.2's inline resolution marker. `still-open` is used when a prior finding is
  judged not yet addressed and is being re-surfaced rather than re-reported as new (§6.7). This
  mirrors the runtime `CodeReviewFinding.status` type already present in `review-pr.ts`. Deferred
  (see §6.9) — the model may populate this today purely from its own reasoning over comment
  history and diff (§6.5–6.8) with no code-side verification.

## 6. State Carried Across Runs

State is split into two independent kinds, tracked by different mechanisms:

**6a. Mechanical state (diff-range resolution) — code-tracked, encoded marker**

- **U-6.1** The system shall persist `lastReviewedSha` (and, for log correlation, `session_id`)
  between runs via an embedded, encoded state marker in the bot's own PR comment.
- **U-6.2** The encoded state marker shall NOT contain finding data (no `blockingFindings` array,
  no per-finding keys, no `status` map) — it exists solely to support diff-range resolution (§1)
  and session correlation. No prior implementation detail (e.g. a `PersistedBlockingFinding`
  type) should survive this requirement; if present in code, it shall be removed rather than left
  unused.
- **U-6.3** `resolveDiffRange`'s incremental-vs-full decision (reachability/ancestor checks against
  `lastReviewedSha`) shall be unaffected by, and shall not depend on, any finding-lifecycle logic.

**6b. Finding lifecycle (resolved vs. still-open) — semantic, model-judged**

- **U-6.4** The system shall fetch the full prior comment history on the PR (not just the most
  recent comment) and shall write it to its own file (e.g. `comments.md`) under the scratch
  context directory, per the file-first delivery mechanism in §2.1 — not concatenated into the
  prompt.
- **U-6.4.1** Each comment entry in `comments.md` shall carry a stable anchor (author + timestamp)
  so the model's output can reference specific prior discussion points meaningfully.
- **U-6.4.2** The system shall strip the encoded state-marker payload (§6.1) out of the bot's own
  comments before writing `comments.md` — the marker is plumbing for diff-range resolution, not
  discussion content, and including it pollutes a file meant to carry human-readable review
  context.
- **U-6.4.3** The system shall visually distinguish the bot's own prior comments from
  human-authored comments in `comments.md` (e.g. separate sections, or a tag per entry), so the
  model does not have to re-derive that filter itself on every run.
- **U-6.5** The system shall NOT maintain a code-level map, key, or `status` field to track
  whether a specific prior finding is resolved — this determination shall be made by the model
  reading the comment history and the current diff together, the same way a human reviewer would.
  (See §5.5, §6.9 — a deterministic version of this tracking is deferred, not rejected.)
- **U-6.6** The system shall instruct the model to treat a prior finding as still open unless the
  comment history and current diff together indicate it was addressed — i.e., silence in the
  incremental diff about a prior finding is not evidence of resolution.
- **U-6.7** The system shall instruct the model not to re-raise a prior finding as newly reported
  once the model judges it addressed; it should instead be acknowledged as resolved in the
  finding output (see §7.2) so the record stays legible without code-side bookkeeping.
- **E-6.8** When a fix introduced in response to prior feedback is found to have introduced a new
  issue that did not previously exist, the system shall instruct the model to raise it as a new
  finding (regression check), reasoning over the same comment history rather than a tracked
  finding-state object.
- **O-6.9** (Deferred, not required for v1.) A deterministic, code-tracked finding-status
  mechanism — e.g. a stable per-finding identifier carried in the state marker purely to verify
  the model's own resolved/open judgment against, without reintroducing full finding payloads
  into the marker (§6.2) — may be revisited once the model-judged approach (§6.5–6.8) has enough
  runs to show whether its false-negative/false-positive rate on resolution calls is acceptable.
  Out of scope until then.

## 7. Output / Comment Formatting

- **U-7.1** The system shall group findings by severity in the posted comment body (Blocking,
  Suggestions, Nits), omitting empty sections.
- **O-7.2** Where a finding carries a `status` (§5.5), the system may render it inline (e.g.
  `_(resolved)_`).
- **UB-7.3** If the model returns zero findings, the system shall post a single summary stating
  no actionable findings were identified, and shall not fabricate filler content.
- **UB-7.4** The system shall instruct the model never to state that the PR is approved or ready
  to merge, and never to attempt to merge the PR.
- **U-7.5** The system shall append the resolved session id (if captured) to the comment for log
  correlation, and shall log a warning if no session id was captured.

## 8. Posting Behavior

- **E-8.1** When the review completes successfully, the system shall post one PR comment via
  `gh pr comment` containing the findings summary and the embedded state marker.
- **UB-8.2** If posting the comment fails (e.g. fork PR without write permission), the system
  shall log a warning and shall not treat this as a fatal error.
- **U-8.3** The system shall force the model to respond only via the `submit_code_review` tool
  call (no free-form conversational output).

## 9. Failure Handling

- **UB-9.1** If the reviewer session fails to return a result, the system shall log an error and
  exit with a non-zero status.
- **U-9.2** The provider proxy server started for the review call shall always be stopped, whether
  the review call succeeds or throws.
