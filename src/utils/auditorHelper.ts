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
 * Additional context to help a session comply on retry (see executeAuditSession).
 * Does not enforce anything by itself -- @github/copilot-sdk has no tool_choice-style
 * enforcement primitive at the session or message level.
 */
export interface ResponseRequirement {
  /**
   * Optional worked example of valid tool-call arguments (as a JSON string).
   * Weaker models sometimes end their turn by writing a text pseudo-call
   * (e.g. `call:toolName{...}`) instead of a real function/tool call. Re-showing
   * a concrete example on retry gives the model something to pattern-match
   * against instead of just being told again to "call the tool".
   */
  readonly toolCallExample?: string;
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
 * - No-conversational-reply enforcement (via systemPrompt)
 * - Tool-specific permission guarding
 *
 * Note: @github/copilot-sdk's SessionConfig has no `tool_choice`-style field --
 * this SDK is an agentic session (the model has a standing toolbox and decides
 * per-turn what to call), not a raw chat-completions call with a per-turn
 * choice policy. Tool-call compliance is instead driven by restricting
 * `availableTools` (see executeAuditSession's retry loop) and by prompting
 * (system prompt + retry nudge with a worked example).
 */
export function buildAuditorSessionSettings(
  executionConfig: ExecutionConfig,
  systemPrompt: string,
  tool: ToolDefinition,
  onResult: (result: unknown) => void
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
    // NOTE: this onPermissionRequest is currently unreachable in practice --
    // CopilotClient.createSession/resumeSession (src/copilotSdk/boundary.ts)
    // default `autoApproveAll` to `true`, which replaces whatever
    // onPermissionRequest is passed here with an unconditional approve-once.
    // Actual tool-use narrowing happens via the `availableTools` restriction
    // applied on retry in executeAuditSession, not via this callback. Kept
    // here (rather than removed) so it takes effect automatically if a caller
    // ever passes `autoApproveAll: false`.
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
      (args) => { result = args as T; }
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
      
      const exampleBlock = responseRequirements.toolCallExample
        ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
        : '';

      const nudge = lastAssistantText.trim()
        ? `You did not call '${toolName}'. Your last message was:

"""
${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}
"""

You must now call '${toolName}' with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call '${toolName}' now.${exampleBlock}`
        : `You ended your turn without calling '${toolName}'. You must now call '${toolName}' with your findings. Do not respond conversationally and do not call any other tool -- call '${toolName}' now.${exampleBlock}`;
        
      session = await client.resumeSession(sessionId, {
        availableTools: [toolName],
        // Re-supply BYOK credentials on every resume. Per the SDK docs, `provider`
        // is NOT persisted across a resume the way most other session config is --
        // it must be re-provided each time, or the resumed session silently loses
        // BYOK and falls back off the configured provider.
        //
        // This currently happens to be harmless here: `client` is never stopped and
        // `session` is never disconnected between the original createSession and this
        // resumeSession call, so the CLI process/connection never actually let go of
        // the credentials -- the resume is live/in-memory, not a cold resume from disk.
        // But that's a lifecycle detail, not a guarantee. If this loop is ever changed
        // to retry after a disconnect, a process restart, or on a different client
        // instance (e.g. a queue/worker picking up the retry), omitting `provider`
        // here would start silently downgrading BYOK sessions to copilot-native on
        // retry. Keep this passed explicitly so correctness doesn't depend on the
        // current call not disconnecting in between.
        ...(executionConfig.provider ? { provider: executionConfig.provider as SdkProviderConfig } : {}),
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
