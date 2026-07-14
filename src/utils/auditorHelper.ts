import { CopilotClient } from '../copilotSdk/boundary';
import { ProviderRegistry, ExecutionConfig } from './providerRegistry';
import { DEFAULT_ROLES_CONFIG } from '../config/models';

/**
 * Requirements for the auditor session response.
 * Controls how tool calls are enforced and guarded.
 */
export interface ResponseRequirement {
  /**
   * The tool_choice setting for the session.
   * Use { type: 'function', function: { name: '...' } } for forced single tool call.
   */
  toolChoice: any;
}

/**
 * Shared logic to resolve the auditor's execution configuration via ProviderRegistry.
 * Ensures both auditors respect DEFAULT_ROLES_CONFIG.auditor.provider.
 * Throws a loud error if no API key is available for the required provider.
 */
export function getAuditorExecutionConfig(apiKey?: string): ExecutionConfig {
  const auditorConfig = DEFAULT_ROLES_CONFIG.auditor;
  const provider = auditorConfig.provider;

  // Resolve the key based on the provider
  let keyToUse = apiKey;
  let envVarName = "GEMINI_API_KEY";

  if (!keyToUse) {
    if (provider === "gemini") {
      keyToUse = process.env.GEMINI_API_KEY;
      envVarName = "GEMINI_API_KEY";
    } else if (provider === "anthropic") {
      keyToUse = process.env.ANTHROPIC_API_KEY;
      envVarName = "ANTHROPIC_API_KEY";
    } else if (provider === "openai") {
      keyToUse = process.env.OPENAI_API_KEY;
      envVarName = "OPENAI_API_KEY";
    } else if (provider === "openrouter") {
      keyToUse = process.env.OPENROUTER_API_KEY;
      envVarName = "OPENROUTER_API_KEY";
    }
  }

  if (!keyToUse && provider !== "copilot-native" && provider !== "local") {
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
  let envVarName = "GEMINI_API_KEY";

  if (!keyToUse) {
    if (provider === "gemini") {
      keyToUse = process.env.GEMINI_API_KEY;
      envVarName = "GEMINI_API_KEY";
    } else if (provider === "anthropic") {
      keyToUse = process.env.ANTHROPIC_API_KEY;
      envVarName = "ANTHROPIC_API_KEY";
    } else if (provider === "openai") {
      keyToUse = process.env.OPENAI_API_KEY;
      envVarName = "OPENAI_API_KEY";
    } else if (provider === "openrouter") {
      keyToUse = process.env.OPENROUTER_API_KEY;
      envVarName = "OPENROUTER_API_KEY";
    }
  }


  if (!keyToUse && provider !== "copilot-native" && provider !== "local") {
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
  tool: any,
  onResult: (result: any) => void,
  responseRequirements: ResponseRequirement) {
  const toolName = tool.function.name;

  return {
    model: executionConfig.model,
    ...(executionConfig.provider ? { provider: executionConfig.provider as any } : {}),
    systemMessage: {
      mode: 'replace',
      content: systemPrompt
    },
    tools: [
      {
        name: toolName,
        description: tool.function.description,
        parameters: tool.function.parameters as any,
        handler: async (args: any) => {
          onResult(args);
          return { status: "received" };
        }
      } ],
    tool_choice: responseRequirements.toolChoice,
    // NOTE: this onPermissionRequest is currently unreachable in practice --
    // CopilotClient.createSession/resumeSession (src/copilotSdk/boundary.ts)
    // default `autoApproveAll` to `true`, which replaces whatever
    // onPermissionRequest is passed here with an unconditional approve-once.
    // Actual tool-use narrowing happens via the `availableTools` restriction
    // applied on retry in executeAuditSession, not via this callback. Kept
    // here (rather than removed) so it takes effect automatically if a caller
    // ever passes `autoApproveAll: false`.
    onPermissionRequest: async (req: any) => {
      const requestedTool = req.toolName || req.name || (req.toolCalls && req.toolCalls[0]?.function?.name);
      const allowed = !requestedTool || requestedTool === toolName || 
        (Array.isArray(req.toolCalls) && req.toolCalls.every((tc: any) => tc.function?.name === toolName));

      return allowed ? { kind: 'approve-once' } : { kind: 'reject', reason: 'Auditor sessions must not execute tools.' };
    },
    streaming: false,
  };
}

/**
 * How much of the model's last assistant message to include when we give up
 * retrying and throw. Long enough to diagnose ("it asked a clarifying
 * question about X" / "it refused because Y"), short enough not to flood logs.
 */
const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

/**
 * Attaches a listener that accumulates the assistant's text content for the
 * *current* turn so that, if the tool is never called, we have something
 * meaningful to report instead of a bare "returned null".
 *
 * Returns a getter for the accumulated text and the unsubscribe function.
 * Callers should reset (re-attach) this per turn, since content naturally
 * accumulates across `assistant.message` / `assistant.message_delta` events.
 */
function trackLastAssistantMessage(session: any): { getText: () => string; unsubscribe: () => void } {
  let text = '';
  const unsubscribe = session.on((event: any) => {
    if (!event) return;
    if (event.type === 'assistant.message') {
      text += event.data?.content || '';
    } else if (event.type === 'assistant.message_delta') {
      text += event.data?.delta || event.data?.content || '';
    }
  });
  return { getText: () => text, unsubscribe };
}

async function sendAndWaitWithAbort(
  session: any,
  prompt: { prompt: string },
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
 *
 * The underlying `@github/copilot-sdk` (v1.0.1) has no `tool_choice`
 * enforcement mechanism -- the `toolChoice` on `responseRequirements` is not
 * read or forwarded by the SDK. The only "enforcement" is the system prompt's
 * plain-English instruction, which the model doesn't always follow (refusal,
 * confusion, clarifying questions, running out of turns exploring context,
 * etc). This encapsulates the client lifecycle logic shared between auditor
 * roles.
 */
export async function executeAuditSession<T>(
  workingDirectory: string,
  executionConfig: ExecutionConfig,
  systemPrompt: string,
  tool: any,
  userPrompt: string,
  responseRequirements: ResponseRequirement,
  abortSignal?: AbortSignal,
  timeoutMs: number = 300000,
  onSessionId?: (sessionId: string) => void,
  maxRetries: number = 2): Promise<T | null> {
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
    let session = await client.createSession(sessionSettings as any);
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

      // Resuming does not implicitly carry over the tool handler,
      // onPermissionRequest, or other session settings -- everything has to
      // be re-supplied explicitly. We also hard-restrict availableTools to
      // just the target tool so the model can't keep exploring/reading files
      // instead of concluding.
      const retrySettings = buildAuditorSessionSettings(
        executionConfig,
        systemPrompt,
        tool,
        (args) => { result = args as T; },
        { toolChoice: responseRequirements.toolChoice }
      );

      const nudge = lastAssistantText.trim()
        ? `You did not call '${toolName}'. Your last message was:\n\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\n\nYou must now call '${toolName}' with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call '${toolName}' now.`
        : `You ended your turn without calling '${toolName}'. You must now call '${toolName}' with your findings. Do not respond conversationally and do not call any other tool -- call '${toolName}' now.`;

      session = await client.resumeSession(sessionId, {
        ...retrySettings,
        availableTools: [toolName],
        systemMessage: {
          mode: 'append',
          content: `\n\nIMPORTANT: ${nudge}`
        },
      } as any);
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
