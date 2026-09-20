/**
 * Hand-maintained builtin tool allowlists passed to `SessionWrapper`'s
 * `toolsConfig.builtins` (issue #77). Hand-maintained ON PURPOSE: a new SDK
 * builtin is granted only by a deliberate human edit here, never silently
 * (SYS-REQ-028a-1 -- omitting a built-in from the construction-time list
 * excludes it for the session's lifetime).
 *
 * The cost of hand-maintenance is drift: an SDK bump that adds, renames, or
 * removes a builtin would otherwise go unnoticed. Two guards close that gap
 * (issue #478):
 *
 * 1. `test/agentCore/builtinToolsSnapshot.test.ts` diffs the LIVE builtin set
 *    the installed SDK declares to the model against the checked-in snapshot
 *    `test/snapshots/builtin-tools.json`, so every SDK-bump change surfaces
 *    as a reviewable diff.
 * 2. The same test asserts every name in BOTH constants below is a real,
 *    currently-live builtin -- so an SDK rename/removal that would leave a
 *    dead name here (silently disabling the tool for every session) fails CI
 *    instead of passing unnoticed.
 *
 * After reviewing a snapshot diff, refresh the checked-in snapshot with:
 * `npm run capture:builtin-tools`
 *
 * CONSTRAINT (see `BUILTIN_TOOL_PERMISSION_KIND` in sessionWrapper.ts):
 * `view`/`grep`/`glob` all resolve to permission-request kind `'read'`, and
 * a request resolved to a shared kind is approved only when EVERY
 * construction-time built-in sharing that kind is enabled. Both constants
 * therefore list all three together or none of them -- do not split them.
 */

/**
 * The standard agent session toolset: shell + file read/write + search.
 * Used by sessions that may modify the repo (auditorHelper's audit sessions,
 * code-change-agent.ts, code-change-agent-open.ts).
 */
export const STANDARD_AGENT_BUILTINS: readonly string[] = ['bash', 'view', 'edit', 'grep', 'glob'];

/**
 * Read-only variant of `STANDARD_AGENT_BUILTINS` (no `edit`) for agents that
 * only report, never fix (audit-codebase.ts).
 */
export const READONLY_AGENT_BUILTINS: readonly string[] = ['bash', 'view', 'grep', 'glob'];
