import { CopilotClient, Tool } from '../copilotSdk/boundary';
import { SessionWrapper, SessionWrapperBaseConfig } from '../copilotSdk/sessionWrapper';
import { checkActiveOrchestrationSession } from '../orchestrator/sessionState';

/**
 * SYS-REQ-029f: a lock-eligible tool must be explicitly declared locked or
 * unlocked -- there is no default. `rationale` makes that choice visible at
 * the call site (SYS-REQ-029i); it's not read by any logic below and exists
 * purely as an enforced code comment.
 */
export type ToolLockPolicy =
  | { readonly mode: 'locked'; readonly rationale: string; readonly getAutoApproveAll?: () => boolean }
  | { readonly mode: 'unlocked'; readonly rationale: string };

export interface RegisteredTool {
  readonly tool: Tool;
  readonly lock: ToolLockPolicy;
}

/**
 * A tool-agnostic session bundle (SYS-REQ-029c). `wrapper` is the plain
 * `SessionWrapper` -- callers pass it to `runForcedToolTurn`/
 * `runForcedToolTurnUntilTimeout`/`sendAndWait` exactly as they would any
 * other `SessionWrapper`. `applyLockPolicy` is the SYS-REQ-029e/f mechanism:
 * it must be called once immediately before every outgoing turn (i.e.
 * immediately before each `wrapper.sendAndWait(...)`), and it is the *only*
 * place orchestration-session state is consulted for these tools -- the
 * tool handlers themselves never read it (SYS-REQ-029e). This is a call
 * site obligation rather than something the unit can enforce by itself
 * without owning the turn loop; migrating existing turn loops to call it is
 * tracked on the follow-up issues (#416/#417), not this one.
 */
export interface AgentSession {
  readonly wrapper: SessionWrapper;
  applyLockPolicy(): void;
}

/**
 * SYS-REQ-029c: builds a `SessionWrapper` from an arbitrary set of tool
 * definitions (not just the shell-exec tool), each with its own lock
 * policy. All tools are registered as `custom` so `SessionWrapper` owns
 * dispatch (SYS-REQ-028a) uniformly across the whole set.
 */
export function createAgentSession(
  client: CopilotClient | undefined,
  tools: readonly RegisteredTool[],
  baseConfig: SessionWrapperBaseConfig = {}
): AgentSession {
  const wrapper = new SessionWrapper(client, { custom: tools.map((t) => t.tool) }, baseConfig);

  const lockedTools = tools.filter(
    (t): t is RegisteredTool & { lock: Extract<ToolLockPolicy, { mode: 'locked' }> } => t.lock.mode === 'locked'
  );

  function applyLockPolicy(): void {
    for (const { tool, lock } of lockedTools) {
      // SYS-REQ-029e: this is the sole place lock-eligible tools' enablement
      // is decided. Rejection of a disabled tool's call still happens
      // exclusively inside `SessionWrapper.onPermissionRequest`
      // (SYS-REQ-028d) -- this only ever calls enableTools/disableTools.
      const gate = checkActiveOrchestrationSession(lock.getAutoApproveAll?.() ?? false, tool.name);
      if (gate.ok) {
        wrapper.enableTools(tool.name);
      } else {
        wrapper.disableTools(tool.name);
      }
    }
  }

  return { wrapper, applyLockPolicy };
}
