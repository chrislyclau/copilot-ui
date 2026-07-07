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
export function defineTool<T = any>(
  name: string,
  description: string,
  parameters: Record<string, any>,
  handler: (args: T) => Promise<any>
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
}

