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

/**
 * How long to tolerate total silence from the SDK (no events of any kind)
 * before treating the current send as a stalled upstream stream rather than
 * a genuine timeout. Matches the watchdog gateLoop.ts uses for the same
 * failure mode (upstream provider issues a tool call, or nothing at all,
 * and then the connection just idles with no session.error ever emitted).
 */
export const STALL_TIMEOUT_MS = 90000;
const STALL_POLL_INTERVAL_MS = 5000;

/**
 * Passed to the SDK's own `session.sendAndWait()` as its internal timeout
 * parameter. Per the SDK's docs, that parameter is an ABSOLUTE deadline --
 * it "does not abort in-flight agent work" and fires purely based on
 * elapsed time, regardless of whether the turn is actively making
 * progress. That's a mismatch with what long-running callers actually
 * want: e.g. review-pr.ts passes 600000 (10 min) meaning "give up if this
 * looks dead", but a legitimately long, healthy, reasoning-heavy turn
 * (many chained tool calls, each punctuated by reasoning-delta events --
 * see reasoningSummary in buildAuditorSessionSettings) can genuinely take
 * longer than that while still making steady progress, and the SDK's
 * absolute clock doesn't care.
 *
 * Only applied when the caller's own `timeoutMs` already exceeds
 * STALL_TIMEOUT_MS -- i.e. they've already opted into a budget long enough
 * that the idle-based stall watchdog below is expected to be the real
 * governor. Callers with a short, genuinely-hard deadline (e.g.
 * gateLoop.ts's clarity/classification checks at 20s/30s) rely on that
 * value firing before stall detection even engages; raising it for them
 * would turn a ~20-30s fail-fast into a multi-minute one (90s stall
 * detection x up to maxStallRetries+1 attempts) for no benefit, since
 * those calls aren't the long-reasoning-turn case this ceiling exists for.
 */
const SDK_HARD_TIMEOUT_CEILING_MS = 30 * 60 * 1000; // 30 minutes

export interface StallError extends Error {
  readonly isStall: true;
}

function isStallError(err: unknown): err is StallError {
  return err instanceof Error && (err as Partial<StallError>).isStall === true;
}

/**
 * Races `session.sendAndWait` against an abort signal (as before) *and* a
 * stall watchdog: if no SDK event of any kind arrives for STALL_TIMEOUT_MS,
 * this rejects with a distinguishable `isStall`-tagged error instead of
 * silently waiting out the full `timeoutMs`. Does not retry by itself --
 * callers (runForcedToolTurn) decide whether/how to retry on a stall, same
 * as gateLoop.ts's own stall watchdog leaves retry policy to its caller.
 *
 * `timeoutMs` is intentionally NOT passed straight through to the SDK's own
 * sendAndWait deadline -- see SDK_HARD_TIMEOUT_CEILING_MS. It's still used
 * as-is for callers who explicitly want longer than that ceiling.
 */
export async function sendAndWaitWithAbort(
  session: CopilotSession,
  prompt: MessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  let lastEventAt = Date.now();
  const unsubscribeStallTracker = session.on(() => {
    lastEventAt = Date.now();
  });

  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setInterval(() => {
      if (Date.now() - lastEventAt > STALL_TIMEOUT_MS) {
        if (stallTimer) clearInterval(stallTimer);
        const err = new Error(
          `Upstream stream stalled: no SDK event received for over ${STALL_TIMEOUT_MS / 1000}s.`,
        ) as StallError;
        (err as { isStall?: boolean }).isStall = true;
        reject(err);
      }
    }, STALL_POLL_INTERVAL_MS);
  });

  const racers: Promise<void>[] = [
    session.sendAndWait(
      prompt,
      timeoutMs > STALL_TIMEOUT_MS ? Math.max(timeoutMs, SDK_HARD_TIMEOUT_CEILING_MS) : timeoutMs,
    ).then(() => undefined),
    stallPromise,
  ];
  if (abortSignal) {
    racers.push(
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }

  try {
    await Promise.race(racers);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    unsubscribeStallTracker();
  }
}

export interface ForcedToolTurnOptions<T> {
  client: CopilotClient;
  abortSignal?: AbortSignal;
  /**
   * Passed down to sendAndWaitWithAbort. If this exceeds STALL_TIMEOUT_MS,
   * termination is effectively governed by the idle-based stall watchdog
   * instead of this value directly (see SDK_HARD_TIMEOUT_CEILING_MS) --
   * intended for long-running, healthy multi-tool-call turns. If this is
   * at or below STALL_TIMEOUT_MS, it's treated as a genuine hard deadline
   * and passed straight through to the SDK unchanged, so short-timeout
   * callers (e.g. gateLoop.ts's clarity/classification checks) still fail
   * fast on a real hang rather than waiting out a stall-detection cycle.
   */
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
  /**
   * How many times to retry after an upstream stall (STALL_TIMEOUT_MS of
   * total SDK silence) before giving up. Tracked separately from
   * `maxRetries` (which governs "turn ended without calling the tool"
   * retries) -- a stall means the model never got a chance to respond at
   * all, so it shouldn't eat into that budget. Default 2, matching
   * gateLoop.ts's per-model stall-retry allowance.
   */
  maxStallRetries?: number;
  /**
   * When provided, a stall recovery creates a brand-new session via
   * `client.createSession(freshSessionConfig)` instead of resuming the
   * stalled one. Resuming a session that never got a response from the
   * upstream provider re-sends into the same (likely still-wedged)
   * conversation; starting fresh avoids that. Because a fresh session has
   * no conversation history, recovery always restarts from `initialPrompt`
   * rather than replaying whatever prompt was in flight (e.g. a nudge),
   * since the fresh session wouldn't have the context a nudge presupposes.
   * If omitted, falls back to the previous `client.resumeSession()`
   * behavior (which does replay the exact in-flight prompt, since resuming
   * preserves conversation history).
   */
  freshSessionConfig?: SessionConfig & { autoApproveAll?: boolean };
  /**
   * Called with the id of every session this turn runs on, including ones
   * created mid-turn by stall recovery (`createSession` or `resumeSession`).
   * Callers that correlate outbound requests via a session id stored
   * globally (e.g. scripts/review-pr.ts's setActiveOpenRouterSessionId)
   * need this to stay in sync across retries -- `onSession` above is for
   * attaching per-session listeners, this is for tracking the id itself.
   */
  onSessionId?: (sessionId: string) => void;
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
  const maxStallRetries = opts.maxStallRetries ?? 2;
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

  /**
   * Sends `promptOpts` to the current session, resuming on a fresh session
   * and retrying the *exact same prompt* (not consuming `maxRetries`, the
   * "tool not called" budget) whenever the send stalls -- mirrors
   * gateLoop.ts's own upstream-stall handling, but generalized here so
   * every executeAuditSession caller (including scripts/review-pr.ts, which
   * has no stall protection of its own) benefits directly.
   */
  const sendWithStallRetry = async (
    promptOpts: { prompt: string; tool_choice?: unknown },
    resumeConfig: { availableTools?: string[]; tools?: unknown; provider?: ProviderConfig },
  ): Promise<void> => {
    let stallAttempt = 0;
    let currentPromptOpts = promptOpts;
    while (true) {
      try {
        await sendAndWaitWithAbort(currentSession, currentPromptOpts as MessageOptions, timeoutMs, opts.abortSignal);
        return;
      } catch (err) {
        if (!isStallError(err)) {
          throw err;
        }
        if (toolCalled) {
          // The target tool already fired (we saw its event) before the
          // stream went quiet -- this "stall" is just the SDK never
          // emitting a final closing event afterward, not a failure to
          // respond. Treat the send as successful rather than discarding
          // the already-completed turn and resending the prompt, which
          // would risk the model calling the tool a second time.
          console.warn(
            `[runForcedToolTurn] upstream went quiet after '${targetTools.join("', '")}' was already called; ` +
            `treating turn as complete instead of retrying.`,
          );
          return;
        }
        if (stallAttempt >= maxStallRetries) {
          throw err;
        }
        stallAttempt++;
        unsubOnSession?.();
        tracker.unsubscribe();
        unsubTool();
        if (opts.freshSessionConfig) {
          console.warn(
            `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
            `starting a new session and retrying the original prompt...`,
          );
          currentSession = await opts.client.createSession(opts.freshSessionConfig);
          currentSessionId = currentSession.sessionId;
          opts.onSessionId?.(currentSessionId);
          currentPromptOpts = { prompt: initialPrompt };
        } else {
          console.warn(
            `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
            `resuming session and retrying the same prompt...`,
          );
          currentSession = await opts.client.resumeSession(currentSessionId, resumeConfig as SessionConfig);
          currentSessionId = currentSession.sessionId;
          opts.onSessionId?.(currentSessionId);
        }
        tracker = trackLastAssistantMessage(currentSession);
        toolCalled = false;
        unsubTool = setupToolListener(currentSession);
        unsubOnSession = opts.onSession?.(currentSession) ?? undefined;
      }
    }
  };

  await sendWithStallRetry({ prompt: initialPrompt }, { tools: opts.tools, ...(executionConfig.provider ? { provider: executionConfig.provider as ProviderConfig } : {}) });
  
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
    opts.onSessionId?.(currentSessionId);
    
    unsubOnSession?.();
    tracker = trackLastAssistantMessage(currentSession);
    toolCalled = false;
    unsubTool = setupToolListener(currentSession);
    unsubOnSession = opts.onSession?.(currentSession) ?? undefined;
    
    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (executionConfig.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }
    
    await sendWithStallRetry(promptOpts, resumeConfig);
    
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
