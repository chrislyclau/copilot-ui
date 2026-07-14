import { CopilotClient, SdkProviderConfig, SessionConfig, CopilotSession, PermissionRequest, PermissionRequestResult } from '../copilotSdk/boundary';
import { ProviderRegistry, ExecutionConfig } from './providerRegistry';
import { DEFAULT_ROLES_CONFIG } from '../config/models';

export interface ToolDefinition {
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Requirements for the auditor session response.
 * Controls how tool calls are enforced and guarded.
 */
export interface ResponseRequirement {
  /**
   * The tool_choice setting for the session.
   * Use { type: 'function', function: { name: '...' } } for forced single tool call.
   */
  readonly toolChoice: unknown;
}

/**
 * Shared logic to resolve the auditor's execution configuration via ProviderRegistry.
 * Ensures both auditors respect DEFAULT_ROLES_CONFIG.auditor.provider. * Throws a loud error if no API key is available for the required provider.
 */
export function getAuditorExecutionConfig(apiKey?: string): ExecutionConfig {
  const auditorConfig = DEFAULT_ROLES_CONFIG.auditor;
  const provider = auditorConfig.provider;
  // Resolve the key based on the provider
  let keyToUse = apiKey;
  let envVarName = 'GEMINI_API_KEY';
  if (!keyToUse) {
    if (provider === 'gemini') {
      keyToUse = process.env.GEMINI_API_KEY;
      envVarName = 'GEMINI_API_KEY';
    } else if (provider === 'anthropic') {
      keyToUse = process.env.ANTHROPIC_API_KEY;
      envVarName = 'ANTHROPIC_API_KEY';
    } else if (provider === 'openai') {
      keyToUse = process.env.OPENAI_API_KEY;
      envVarName = 'OPENAI_API_KEY';
    } else if (provider === 'openrouter') {
      keyToUse = process.env.OPENROUTER_API_KEY;
      envVarName = 'OPENROUTER_API_KEY';
    }
  }

  if (!keyToUse && provider !== 'copilot-native' && provider !== 'local') {
    throw new Error(
      `Missing API key for auditor provider "${provider}". Expected ${envVarName} to be set.`,
    );
  }
  const registry = new ProviderRegistry(keyToUse);
  return registry.getExecutionConfig(auditorConfig);
}

/**
 * Shared logic to resolve the reviewer's execution configuration via ProviderRegistry.
 * Independently configurable from the auditor role (REVIEWER_PROVIDER/REVIEWER_MODEL),
 * so PR-facing review can use a different, likely stronger, model without affecting
 * the in-loop spec auditor.
 * Throws a loud error if no API key is available for the required provider.
 */
export function getReviewerExecutionConfig(apiKey?: string): ExecutionConfig {
  const reviewerConfig = DEFAULT_ROLES_CONFIG.reviewer;
  const provider = reviewerConfig.provider;
  let keyToUse = apiKey;
  let envVarName = 'GEMINI_API_KEY';
  if (!keyToUse) {
    if (provider === 'gemini') {
      keyToUse = process.env.GEMINI_API_KEY;
      envVarName = 'GEMINI_API_KEY';
    } else if (provider === 'anthropic') {
      keyToUse = process.env.ANTHROPIC_API_KEY;
      envVarName = 'ANTHROPIC_API_KEY';
    } else if (provider === 'openai') {
      keyToUse = process.env.OPENAI_API_KEY;
      envVarName = 'OPENAI_API_KEY';
    } else if (provider === 'openrouter') {
      keyToUse = process.env.OPENROUTER_API_KEY;
      envVarName = 'OPENROUTER_API_KEY';
    }
  }

  if (!keyToUse && provider !== 'copilot-native' && provider !== 'local') {
    throw new Error(
      `Missing API key for reviewer provider "${provider}". Expected ${envVarName} to be set.`,
    );
  }
  const registry = new ProviderRegistry(keyToUse);
  return registry.getExecutionConfig(reviewerConfig);
}

/**
 * Shared session settings for auditors:
 * - Configurable tool-call enforcement via responseRequirements
 * - No-conversational-reply enforcement
 * - Tool-specific permission guarding
 */
export function buildAuditorSessionSettings(
  executionConfig: ExecutionConfig,
  systemPrompt: string,
  tool: ToolDefinition,
  onResult: (result: unknown) => void,
  responseRequirements: ResponseRequirement
) {
  const toolName = tool.function.name;
  return {
    model: executionConfig.model,
    ...(executionConfig.provider ? { provider: executionConfig.provider as SdkProviderConfig } : {}),
    systemMessage: {
        mode: "customize",
        sections: {
            tone: {
                action: "remove"
            },
            code_change_rules: { action: "remove" },
            guidelines: {
                action: "remove"
            },
            // tool_instructions: { action: "preserve" },
            // environment_context: { action: "preserve" },
            // tool_efficiency: { action: "preserve" },
            preamble: { action: "remove" },
            // identity: { action: "remove" },
            safety: { action: "remove" },
            custom_instructions: { action: "remove" },
            // runtime_instructions: { action: "remove" },
            last_instructions: { action: "remove" }
        },
        content: systemPrompt,
    },
    tools: [
      {
        name: toolName,
        description: tool.function.description,
        parameters: tool.function.parameters,
        handler: async (args: unknown) => {
          onResult(args);
          return { status: 'received' };
        }
      }
    ],
    tool_choice: responseRequirements.toolChoice,
    onPermissionRequest: async (req: PermissionRequest): Promise<PermissionRequestResult> => {
      const record = req as unknown as Record<string, unknown>;
      const requestedTool = (record.toolName as string | undefined) || 
                            (record.name as string | undefined) || 
                            (Array.isArray(record.toolCalls) && record.toolCalls[0] && typeof record.toolCalls[0] === 'object'
                              ? ((record.toolCalls[0] as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name as string | undefined
                              : undefined);
      const allowed = !requestedTool || requestedTool === toolName || 
                      (Array.isArray(record.toolCalls) && record.toolCalls.every((tc: unknown) => 
                        tc && typeof tc === 'object' && ((tc as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name === toolName));
      return allowed ? { kind: 'approve-once' } : { kind: 'reject', feedback: 'Auditor sessions must not execute tools.' };
    },
    streaming: false,
  };
}

/**
 * How much of the model's last assistant message to include when we give up
 * retrying and throw. Long enough to diagnose, short enough not to flood logs.
 */
const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

/**
 * Attaches a listener that accumulates the assistant's text content for the
 * current turn so that, if the tool is never called, we have something
 * meaningful to report instead of a bare "returned null".
 * 
 * Returns a getter for the accumulated text and the unsubscribe function.
 */
function trackLastAssistantMessage(session: CopilotSession): { readonly getText: () => string; readonly unsubscribe: () => void } {
  let text = '';
  const unsubscribe = session.on((event: unknown) => {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const evData = ev.data as Record<string, unknown> | undefined;
    if (ev.type === 'assistant.message') {
      text += (evData?.content as string | undefined) || '';
    } else if (ev.type === 'assistant.message_delta') {
      text += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
    }
  });
  return { getText: () => text, unsubscribe };
}

async function sendAndWaitWithAbort(
  session: CopilotSession,
  prompt: { readonly prompt: string },
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) {
    await session.sendAndWait(prompt, timeoutMs);
    return;
  }
  await Promise.race([
    session.sendAndWait(prompt, timeoutMs),
    new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    })
  ]);
}

/**
 * Manages the lifecycle of a CopilotClient (start/stop) and executes an audit
 * turn, retrying with a restricted toolset if the model ends its turn without
 * calling the target tool.
 */
export async function executeAuditSession<T>(
  workingDirectory: string,
  executionConfig: ExecutionConfig,
  systemPrompt: string,
  tool: ToolDefinition,
  userPrompt: string,
  responseRequirements: ResponseRequirement,
  abortSignal?: AbortSignal,
  timeoutMs: number = 300000,
  onSessionId?: (sessionId: string) => void,
  maxRetries: number = 2
): Promise<T | null> {
  const client = new CopilotClient({
    workingDirectory,
    logLevel: 'none',
    useLoggedInUser: false,
  });
  const toolName = tool.function.name;
  let result: T | null = null;
  let lastAssistantText = '';
  let sessionId: string | undefined;
  
  try {
    console.log('[executeAuditSession] starting client...');
    await client.start();
    
    const sessionSettings = buildAuditorSessionSettings(
      executionConfig,
      systemPrompt,
      tool,
      (args) => { result = args as T; },
      responseRequirements
    );
    
    console.log('[executeAuditSession] creating session...');
    let session = await client.createSession(sessionSettings as SessionConfig & { autoApproveAll?: boolean });
    sessionId = session.sessionId;
    console.log(`[executeAuditSession] session created: ${session.sessionId}`);
    onSessionId?.(session.sessionId);
    
    let tracker = trackLastAssistantMessage(session);
    console.log('[executeAuditSession] sending and waiting for response...');
    await sendAndWaitWithAbort(session, { prompt: userPrompt }, timeoutMs, abortSignal);
    lastAssistantText = tracker.getText();
    tracker.unsubscribe();
    
    let attempt = 0;
    while (result === null && attempt < maxRetries) {
      attempt++;
      console.warn(
        `[executeAuditSession] turn ended without '${toolName}' being called ` +
        `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
      );
      
      // const retrySettings = buildAuditorSessionSettings(
      //   executionConfig,
      //   systemPrompt,
      //   tool,
      //   (args) => { result = args as T; },
      //   { toolChoice: responseRequirements.toolChoice }
      // );
      
      const nudge = lastAssistantText.trim()
        ? `You did not call '${toolName}'. Your last message was:

"""
${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}
"""

You must now call '${toolName}' with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call '${toolName}' now.`
        : `You ended your turn without calling '${toolName}'. You must now call '${toolName}' with your findings. Do not respond conversationally and do not call any other tool -- call '${toolName}' now.`;
        
      session = await client.resumeSession(sessionId, {
        availableTools: [toolName],
      } as SessionConfig & { autoApproveAll?: boolean });
      
      sessionId = session.sessionId;
      onSessionId?.(session.sessionId);
      tracker = trackLastAssistantMessage(session);
      await sendAndWaitWithAbort(session, { prompt: nudge }, timeoutMs, abortSignal);
      lastAssistantText = tracker.getText() || lastAssistantText;
      tracker.unsubscribe();
    }
    
    console.log('[executeAuditSession] disconnecting session...');
    await session.disconnect();
    
    if (result === null) {
      const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
      throw new Error(
        `Reviewer session ended without calling '${toolName}' after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
        `Model's last message: ${truncated || '(no assistant text captured)'}`
      );
    }
    
    console.log('[executeAuditSession] complete!');
    return result;
  } finally {
    try {
      await client.stop();
    } catch (e) {
      // Silence stop errors as the main intent (audit result) is already captured or failed
    }
  }
}
