import { CopilotClient as BaseCopilotClient } from '@github/copilot-sdk';
import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  Tool,
} from '@github/copilot-sdk';

export type {
  CopilotSession,
  PermissionRequest,
  AssistantMessageDeltaEvent,
  AssistantReasoningDeltaEvent,
  AssistantStreamingDeltaEvent,
  PermissionRequestResult,
  ProviderConfig as SdkProviderConfig,
  SessionConfig,
  SessionEvent,
  MessageOptions,
  Tool,
  ToolExecutionCompleteContent,
  ToolExecutionCompleteEvent,
} from '@github/copilot-sdk';

/**
 * Creates and registers a custom Tool definition with clean, abstracted typing.
 */
export function defineTool<T = unknown>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: T) => Promise<unknown>
): Tool<T> {
  return {
    name,
    description,
    parameters,
    handler,
  };
}

/**
 * Abstracted CopilotClient subclass that automatically overrides session configuration
 * to support global, hassle-free auto-approval for all tools and command executions.
 */
export class CopilotClient extends BaseCopilotClient {
  override async createSession(
    config: SessionConfig & { autoApproveAll?: boolean }
  ): Promise<CopilotSession> {
    const { autoApproveAll = true, ...baseConfig } = config;

    // If autoApproveAll is enabled, bypass standard gate approvals and auto-approve everything
    const onPermissionRequest = autoApproveAll
      ? async (req: PermissionRequest): Promise<PermissionRequestResult> => {
          return { kind: 'approve-once' };
        }
      : baseConfig.onPermissionRequest;

    return super.createSession({
      ...baseConfig,
      onPermissionRequest,
    });
  }

  /**
   * Mirrors createSession's autoApproveAll behavior for resumed sessions.
   * Without this override, resumeSession falls through to the base SDK,
   * which does not apply any default onPermissionRequest -- callers that
   * relied on createSession's auto-approve default would silently stop
   * getting it the moment they resume a session (e.g. auditor retry loops).
   *
   * Separately: this override does NOT protect callers against the SDK's
   * systemMessage-drop-on-resume hazard -- resumeSession does not inherit
   * systemMessage from the session being resumed, so any caller building a
   * resumeConfig must explicitly re-pass systemMessage or silently lose it.
   * See AGENTS.md ("resumeSession() drops the system prompt unless you
   * re-pass it") for the general rule and issue #208 for the original bug.
   */
  override async resumeSession(
    sessionId: string,
    config: SessionConfig & { autoApproveAll?: boolean }
  ): Promise<CopilotSession> {
    const { autoApproveAll = true, ...baseConfig } = config;

    const onPermissionRequest = autoApproveAll
      ? async (req: PermissionRequest): Promise<PermissionRequestResult> => {
          return { kind: 'approve-once' };
        }
      : baseConfig.onPermissionRequest;

    return super.resumeSession(sessionId, {
      ...baseConfig,
      onPermissionRequest,
    });
  }
}

