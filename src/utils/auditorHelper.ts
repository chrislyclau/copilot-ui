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
  /**
   * If true, allows tools other than the primary auditor tool.
   * If false, rejects any tool call that doesn't match the primary tool.
   */
  allowOthers: boolean;
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
    onPermissionRequest: async (req: any) => {
      if (responseRequirements.allowOthers) return { kind: 'approve-once' };
      const requestedTool = req.toolName || req.name || (req.toolCalls && req.toolCalls[0]?.function?.name);
      const allowed = !requestedTool || requestedTool === toolName || 
        (Array.isArray(req.toolCalls) && req.toolCalls.every((tc: any) => tc.function?.name === toolName));

      return allowed ? { kind: 'approve-once' } : { kind: 'reject', reason: 'Auditor sessions must not execute tools.' };
    },
    streaming: false,
  };
}

/**
 * Manages the lifecycle of a CopilotClient (start/stop) and executes a single-turn audit.
 * This encapsulates the client lifecycle logic shared between auditor roles.
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
  onSessionId?: (sessionId: string) => void): Promise<T | null> {
  const client = new CopilotClient({
    workingDirectory,
    logLevel: 'none',
    useLoggedInUser: false,
  });
  let result: T | null = null;
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
    const session = await client.createSession(sessionSettings as any);
    console.log(`[executeAuditSession] session created: ${session.sessionId}`);
    onSessionId?.(session.sessionId);
    console.log('[executeAuditSession] sending and waiting for response...');
    if (abortSignal) {
      await Promise.race([
        session.sendAndWait({ prompt: userPrompt }, timeoutMs),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
          if (abortSignal.aborted) onAbort();
          else abortSignal.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } else {
      await session.sendAndWait({ prompt: userPrompt }, timeoutMs);
    }
    console.log('[executeAuditSession] disconnecting session...');
    await session.disconnect();

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
