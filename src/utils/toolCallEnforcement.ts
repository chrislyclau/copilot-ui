import { CopilotClient, CopilotSession, SdkProviderConfig as ProviderConfig, SessionConfig, MessageOptions } from '../copilotSdk/boundary';

/**
 * How much of the model's last assistant message to include when we give up
 * retrying and throw. Long enough to diagnose, short enough not to flood logs.
 */
export const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

export function truncate(text: string, maxLength: number): string {
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
export function trackLastAssistantMessage(session: CopilotSession): { readonly getText: () => string; readonly unsubscribe: () => void } {
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

export async function sendAndWaitWithAbort(
  session: CopilotSession,
  prompt: MessageOptions,
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

export interface ForcedToolTurnOptions<T> {
  client: CopilotClient;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  tools?: any[]; // CopilotSDK Tool array
  responseRequirements?: { toolCallExample?: string };
  /**
   * Called with every session this turn runs on -- the initial session, and
   * each brand-new session object produced by `client.resumeSession()` on a
   * nudge retry. `resumeSession` returns a *different* CopilotSession object
   * each time, so any listener a caller attaches only to the session passed
   * into `runForcedToolTurn` will silently stop firing the moment a retry
   * happens. Callers that need to capture something off the tool call itself
   * (e.g. its arguments), rather than just knowing a tool was called, should
   * attach their listener here instead of on the original session, and return
   * an unsubscribe function so it can be cleaned up before the next resume.
   */
  onSession?: (session: CopilotSession) => (() => void) | void;
}

export async function runForcedToolTurn<T>(
  session: CopilotSession,
  executionConfig: { provider?: unknown },
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  let currentSession = session;
  let currentSessionId = session.sessionId;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};
  
  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  let tracker = trackLastAssistantMessage(currentSession);
  
  const setupToolListener = (s: CopilotSession) => {
    const unsub = s.on((event: unknown) => {
      const ev = event as Record<string, unknown>;
      if (
        (ev.type === 'tool.user_requested' && targetTools.includes((ev.data as any)?.toolName)) ||
        (ev.type === 'tool.execution_start' && targetTools.includes((ev.data as any)?.toolName)) ||
        (ev.type === 'external_tool.requested' && targetTools.includes((ev.data as any)?.toolName)) ||
        (ev.type === 'tool.execution_complete' && (ev.data as any)?.toolCallId && targetTools.some(t => (ev.data as any).toolCallId === `call-${t}`)) ||
        (ev.type === 'tool.execution_complete' && targetTools.includes((ev.data as any)?.toolName))
      ) {
        toolCalled = true;
      }
    });
    return unsub;
  };
  
  let unsubTool = setupToolListener(currentSession);
  let unsubOnSession = opts.onSession?.(currentSession) ?? undefined;
  
  await sendAndWaitWithAbort(currentSession, { prompt: initialPrompt }, timeoutMs, opts.abortSignal);
  
  let lastAssistantText = tracker.getText();
  tracker.unsubscribe();
  unsubTool();
  
  let attempt = 0;
  
  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurn] turn ended without ${toolNamesStr} being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );
    
    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;
      
    const resumeConfig = {
      availableTools: targetTools,
      tools: opts.tools,
      ...(executionConfig.provider ? { provider: executionConfig.provider as ProviderConfig } : {}),
    };
    
    currentSession = await opts.client.resumeSession(currentSessionId, resumeConfig);
    currentSessionId = currentSession.sessionId;
    
    unsubOnSession?.();
    tracker = trackLastAssistantMessage(currentSession);
    toolCalled = false;
    unsubTool = setupToolListener(currentSession);
    unsubOnSession = opts.onSession?.(currentSession) ?? undefined;
    
    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (executionConfig.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }
    
    await sendAndWaitWithAbort(currentSession, promptOpts, timeoutMs, opts.abortSignal);
    
    lastAssistantText = tracker.getText() || lastAssistantText;
    tracker.unsubscribe();
    unsubTool();

  }
  
  unsubOnSession?.();
  
  if (!toolCalled) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling ${toolNamesStr} after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }
  
  let finalResult = opts.getResult();
  if (toolCalled && (finalResult === null || finalResult === undefined)) {
    finalResult = (true as unknown) as T;
  }
  
  return { result: finalResult as T, session: currentSession, lastAssistantText, toolCalled };
}
