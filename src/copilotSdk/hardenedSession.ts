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

function extractRequestedToolName(req: PermissionRequest): string | undefined {
  const record = req as unknown as Record<string, unknown>;
  if (typeof record.toolName === 'string') return record.toolName;
  if (typeof record.name === 'string') return record.name;
  const toolCalls = record.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls[0] && typeof toolCalls[0] === 'object') {
    const fn = (toolCalls[0] as Record<string, unknown>).function;
    if (fn && typeof fn === 'object') {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === 'string') return name;
    }
  }
  return undefined;
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
): (req: PermissionRequest) => Promise<PermissionRequestResult> {
  const allowed = new Set(policy.autoApprovedTools);
  return async (req: PermissionRequest): Promise<PermissionRequestResult> => {
    const requestedTool = extractRequestedToolName(req);
    if (requestedTool && allowed.has(requestedTool)) {
      return { kind: 'approve-once' };
    }
    console.warn(
      `[hardenedSession] rejected permission request for disallowed tool ` +
      `'${requestedTool ?? '(unrecognized)'}' (allowed: ${[...allowed].join(', ') || '(none)'})`
    );
    return {
      kind: 'reject',
      feedback: requestedTool
        ? `Tool '${requestedTool}' is not permitted under this session's policy.`
        : `This tool request is not permitted under this session's policy.`,
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
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionRequestResult>;
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
