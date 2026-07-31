import {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  Tool,
} from './boundary';

/**
 * Sole entry point for creating (and, per issue #246 item 2, resuming)
 * CopilotSessions with an enforced tool policy. No other module should call
 * `CopilotClient.createSession`/`resumeSession` directly -- see issue #246
 * for the regressions (dropped `onPermissionRequest`/`availableTools` on
 * resume) that motivated centralizing this here.
 */

/**
 * A session's tool policy, bound immutably at creation time. Every field the
 * SDK needs to keep a session scoped -- `availableTools`, `tools`,
 * `systemMessage`, and the auto-approve allowlist -- lives here instead of
 * being reconstructed ad hoc at each call site.
 */
export interface SessionPolicy {
  /** SDK-level allowlist restricting which built-in/custom tools the model may call at all. */
  readonly availableTools: readonly string[];
  /** Custom tool definitions (handlers) registered for the session, if any. */
  readonly tools?: readonly Tool[];
  readonly systemMessage?: SessionConfig['systemMessage'];
  /**
   * Tool names that may be auto-approved without a human/caller decision.
   * Anything requested outside this set is rejected by the policy's
   * `onPermissionRequest` handler -- see `derivePermissionHandler` below.
   */
  readonly autoApprovedTools: readonly string[];
}

/** Config fields callers must NOT supply themselves -- always derived from the policy. */
type PolicyOwnedConfigKeys = 'availableTools' | 'tools' | 'systemMessage' | 'autoApproveAll' | 'onPermissionRequest';

/** Whatever the caller still needs to provide (workingDirectory, model, provider, etc). */
export type HardenedSessionBaseConfig = Omit<SessionConfig, PolicyOwnedConfigKeys>;

/**
 * Resolves the tool name to check against `autoApprovedTools` from a
 * `PermissionRequest`. The SDK's `PermissionRequest` union is discriminated
 * by `kind`, and only three of its nine variants (`mcp`, `custom-tool`,
 * `hook`) carry a `toolName` field -- the built-in variants (`shell`,
 * `write`, `read`, `url`, `memory`, `extension-management`,
 * `extension-permission-access`) have no such field, since for those the
 * `kind` itself already identifies which built-in tool is being gated.
 * Switching on `kind` (rather than probing for a `toolName`/`name`
 * property) is required to resolve a name for those built-ins; probing
 * alone always returns `undefined` for them, which would make
 * `derivePermissionHandler` unconditionally reject them regardless of
 * `autoApprovedTools`.
 */
function extractRequestedToolName(req: PermissionRequest): string {
  switch (req.kind) {
    case 'mcp':
    case 'custom-tool':
    case 'hook':
      return req.toolName;
    case 'shell':
    case 'write':
    case 'read':
    case 'url':
    case 'memory':
    case 'extension-management':
    case 'extension-permission-access':
      return req.kind;
    default: {
      // Exhaustiveness guard: if the SDK adds a new PermissionRequest
      // variant, fall back to its `kind` rather than silently mishandling it.
      const unknownReq = req as { kind: string };
      return unknownReq.kind;
    }
  }
}

/**
 * Records rejected permission attempts per session, keyed by session id, so
 * callers/tests can verify *what* was attempted and rejected -- not just
 * that a rejection happened. Console output alone (the previous behavior)
 * isn't queryable and disappears once the process log rotates; this is
 * issue #246 item 3's "the attempted tool name is recorded" requirement.
 */
const rejectedAttemptsBySessionId = new Map<string, string[]>();

/**
 * Returns the tool names rejected so far for `sessionId`, in the order they
 * were attempted. Returns an empty array (not undefined) for a session with
 * no rejections on file, so callers don't need an existence check.
 */
export function getRejectedToolAttempts(sessionId: string): readonly string[] {
  return rejectedAttemptsBySessionId.get(sessionId) ?? [];
}

/** Clears recorded rejection history for a session, e.g. alongside `deleteHardenedSessionPolicy` during cleanup. */
export function clearRejectedToolAttempts(sessionId: string): void {
  rejectedAttemptsBySessionId.delete(sessionId);
}

function recordRejectedAttempt(sessionId: string, toolName: string): void {
  const existing = rejectedAttemptsBySessionId.get(sessionId);
  if (existing) {
    existing.push(toolName);
  } else {
    rejectedAttemptsBySessionId.set(sessionId, [toolName]);
  }
}

/**
 * Builds the `onPermissionRequest` handler enforcing `autoApprovedTools`.
 * Anything not in that set is rejected (issue #246's "disallowed-tool
 * rejection" requirement) rather than falling through to
 * `CopilotClient`'s own `autoApproveAll` default of `true`
 * (src/copilotSdk/boundary.ts) -- this handler is only ever installed
 * alongside `autoApproveAll: false`, so that default never applies here.
 *
 * Built-in tools like `bash`/`view`/`grep`/`task` (subagent) are rejected
 * by this same path whenever they're absent from `autoApprovedTools` --
 * there is no separate allowlist for them, so they stay unavailable by
 * default unless a policy explicitly opts them in (issue #246's
 * state-driven requirement).
 */
function derivePermissionHandler(
  policy: SessionPolicy
): (req: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult> {
  const allowed = new Set(policy.autoApprovedTools);
  return async (req: PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> => {
    const requestedTool = extractRequestedToolName(req);
    if (allowed.has(requestedTool)) {
      return { kind: 'approve-once' };
    }
    recordRejectedAttempt(invocation.sessionId, requestedTool);
    console.warn(
      `[hardenedSession] session ${invocation.sessionId}: rejected permission request for disallowed ` +
      `tool '${requestedTool}' (allowed: ${[...allowed].join(', ') || '(none)'})`
    );
    return {
      kind: 'reject',
      feedback: `Tool '${requestedTool}' is not permitted under this session's policy.`,
    };
  };
}

/**
 * Derives the full, non-partial session config from a policy. Every field
 * below is intentionally always present -- see issue #246's requirement
 * that a resume path omitting any of these fail type-check rather than
 * silently falling back to SDK defaults. (Resume support itself is item 2;
 * this is shared by both create and, later, resume.)
 */
export function deriveSessionConfig(
  policy: SessionPolicy
): Pick<SessionConfig, 'availableTools' | 'tools' | 'systemMessage'> & {
  autoApproveAll: false;
  onPermissionRequest: (req: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult>;
} {
  return {
    availableTools: [...policy.availableTools] as SessionConfig['availableTools'],
    tools: (policy.tools ? [...policy.tools] : []) as SessionConfig['tools'],
    systemMessage: policy.systemMessage,
    autoApproveAll: false,
    onPermissionRequest: derivePermissionHandler(policy),
  };
}

/** Tracks each hardened session's originating policy, keyed by session id, so a future resume (item 2) can re-derive the same config without the caller re-supplying it. */
const policyBySessionId = new Map<string, SessionPolicy>();

/** @internal exposed for hardenedSession's own resume implementation (item 2) and its tests. */
export function getStoredPolicy(sessionId: string): SessionPolicy | undefined {
  return policyBySessionId.get(sessionId);
}

/**
 * Evicts a session's stored policy once the caller knows the session is
 * done for good (e.g. on disconnect/cleanup in a long-running process).
 * Without this, `policyBySessionId` only grows -- every `createHardenedSession`
 * call adds an entry that nothing else removes. Not wired into any session
 * lifecycle yet (that's part of item 7, migrating real callers); exposed now
 * so that migration has a cleanup hook to call instead of reinventing one.
 */
export function deleteHardenedSessionPolicy(sessionId: string): void {
  policyBySessionId.delete(sessionId);
  clearRejectedToolAttempts(sessionId);
}

/**
 * Creates a new CopilotSession with `policy` bound to it for the lifetime of
 * the session (including any future resume -- item 2). This is the only
 * sanctioned way to create a session under a tool policy; call sites must
 * not call `client.createSession` directly (issue #246).
 */
export async function createHardenedSession(
  client: CopilotClient,
  baseConfig: HardenedSessionBaseConfig,
  policy: SessionPolicy
): Promise<CopilotSession> {
  const session = await client.createSession({
    ...baseConfig,
    ...deriveSessionConfig(policy),
  });
  policyBySessionId.set(session.sessionId, policy);
  return session;
}

/**
 * Binds `policy` to `sessionId` without going through `createHardenedSession`.
 *
 * Exists for sessions that predate the hardened wrapper -- e.g. the sessions
 * `runForcedToolTurn`/`runForcedToolTurnUntilTimeout` in
 * `toolCallEnforcement.ts` receive as an argument, already created by their
 * caller. Migrating those call sites to `createHardenedSession` outright is
 * issue #246 item 7 (out of scope here); until then, this lets them register
 * a policy for a session they didn't create so `resumeHardenedSession` still
 * has something non-partial to derive a resume config from.
 */
export function registerSessionPolicy(sessionId: string, policy: SessionPolicy): void {
  policyBySessionId.set(sessionId, policy);
}

/**
 * Resumes a session under its stored policy. Per issue #246's requirement
 * that a resume path never accept partial/caller-supplied config, this
 * takes no config argument at all -- the full `SessionConfig` is always
 * re-derived from whatever policy is on file for `sessionId` via
 * `deriveSessionConfig`, the same derivation `createHardenedSession` uses.
 *
 * This is what fixes the two regressions issue #246 was opened over:
 * `runForcedToolTurnUntilTimeout`'s nudge-retry resume no longer has a code
 * path where it can drop `onPermissionRequest`/`autoApproveAll`, and
 * `runForcedToolTurn`'s stall-retry resume no longer has one where it can
 * drop `availableTools` -- both are always present because
 * `deriveSessionConfig` always sets them, unconditionally.
 *
 * Throws if no policy is on file for `sessionId` (e.g. it was never created
 * via `createHardenedSession`/`registerSessionPolicy`, or its policy was
 * already evicted via `deleteHardenedSessionPolicy`) rather than silently
 * falling back to the SDK's own resume defaults -- that fallback is exactly
 * the failure mode this module exists to close off.
 *
 * `resumeSession` may hand back a session under a different `sessionId`
 * than the one passed in; the policy is re-keyed under whatever id the SDK
 * settles on so a *subsequent* resume of the same logical session still
 * finds it, and the stale entry under the old id is dropped so it doesn't
 * linger unused.
 */
export async function resumeHardenedSession(
  client: CopilotClient,
  sessionId: string,
  /**
   * Non-policy-owned fields (e.g. `provider`) the caller still needs to pass
   * through on resume, same shape `createHardenedSession` takes for the
   * initial create. Never used to supply `availableTools`, `tools`,
   * `systemMessage`, `autoApproveAll`, or `onPermissionRequest` -- those
   * remain exclusively policy-derived; `HardenedSessionBaseConfig` excludes
   * them at the type level.
   */
  baseConfig: HardenedSessionBaseConfig = {}
): Promise<CopilotSession> {
  const policy = getStoredPolicy(sessionId);
  if (!policy) {
    throw new Error(
      `[hardenedSession] resumeHardenedSession: no policy registered for session ${sessionId}. ` +
      `Sessions must be created via createHardenedSession or registered via registerSessionPolicy ` +
      `before they can be resumed through this module.`
    );
  }
  const session = await client.resumeSession(sessionId, {
    ...baseConfig,
    ...deriveSessionConfig(policy),
  } as SessionConfig);
  if (session.sessionId !== sessionId) {
    policyBySessionId.delete(sessionId);
  }
  policyBySessionId.set(session.sessionId, policy);
  return session;
}
