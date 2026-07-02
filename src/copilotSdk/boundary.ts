// Single import boundary for @github/copilot-sdk so the app can swap or shim it in one place.
export { CopilotClient } from '@github/copilot-sdk';
export type {
  AssistantMessageDeltaEvent,
  AssistantReasoningDeltaEvent,
  AssistantStreamingDeltaEvent,
  PermissionRequestResult,
  ProviderConfig as SdkProviderConfig,
  SessionConfig,
  SessionEvent,
  Tool,
  ToolExecutionCompleteContent,
} from '@github/copilot-sdk';
