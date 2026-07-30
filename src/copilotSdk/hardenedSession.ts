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
 * Builds the `onPermissionRequest` handler enforcing `autoApprovedTools`.
 * Anything not in that set is rejected (issue #246's "disallowed-tool
 * rejection" requirement) rather than falling through to
 * `CopilotClient`'s own `autoApproveAll` default of `true`
 * (src/copilotSdk/boundary.ts) -- this handler is only ever installed
 * alongside `autoApproveAll: false`, so that default never applies here.
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
