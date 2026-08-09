/**
 * `*.pure.ts` convention (issue #320): this file must not import anything
 * I/O-bearing -- fs, child_process, net/http, ../workspace (or any module
 * that transitively reaches getExecCommand/getGitSandbox), SDK client
 * modules, etc. Enforced by eslint.config.js's `**\/*.pure.ts` block. See
 * AGENTS.md for the full rule and rationale.
 *
 * `isAIStudio()` reads only `process.env` -- no filesystem, network, or
 * process-spawning I/O -- so it's a clean second reference case alongside
 * auditorHelper.pure.ts's buildAuditorSessionDeclarativeSettings.
 */
export function isAIStudio(): boolean {
  return process.env.AI_STUDIO === "true" || process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}
