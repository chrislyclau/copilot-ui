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
 * Execution-aware silence tracking (see AGENTS.md: "Execution-aware silence
 * tracking" and the "Stall-watchdog recovery retired..." entry it's
 * cross-referenced from).
 *
 * Tracks time since the last SDK event of any kind, but treats time spent
 * inside a tool call -- between `tool.execution_start` and
 * `tool.execution_complete`, the only events bookending it -- as *not*
 * silence: a slow-but-healthy tool (`npx tsc`, a large `grep`, a slow `gh`
 * call) must not be mistaken for a dead upstream connection (issues
 * #188/#191, reproduced on PR #136).
 *
 * Currently only consumed by the dormant `sendAndWaitWithAbort` stall
 * watchdog below. Pulled out as a standalone, documented utility -- not
 * because it's used anywhere else today, but so the pattern is easy to find
 * and reuse if a genuine stall is ever observed independently of turn
 * duration, per issue #207's guidance not to leave that logic to be
 * rediscovered from scratch.
 *
 * Deliberately event-driven rather than self-subscribing to `session.on`:
 * the SDK (and this codebase's mocks of it) treat `session.on` as a single
 * active listener, so a caller that also needs its own listener for other
 * event types (tool-name logging, usage telemetry, etc.) must funnel every
 * event through one subscription. Callers feed events in via `recordEvent`.
 */
export function createExecutionAwareSilenceTracker() {
  let lastEventAt = Date.now();
  let lastEventType: string | undefined;
  let toolExecutionActive = false;

  return {
    /** Feed the next raw SDK event to the tracker; call this from your own `session.on` listener for every event. */
    recordEvent(event: unknown): void {
      lastEventAt = Date.now();
      if (!event || typeof event !== 'object' || !('type' in event)) return;
      const ev = event as Record<string, unknown>;
      lastEventType = String(ev.type);
      if (ev.type === 'tool.execution_start') toolExecutionActive = true;
      if (ev.type === 'tool.execution_complete') toolExecutionActive = false;
    },
    /**
     * Milliseconds since the last recorded event, or `null` while a tool is
     * actively executing -- execution time never counts as silence, and
     * the clock effectively resumes counting once `tool.execution_complete`
     * fires and resets `lastEventAt`.
     */
    silentForMs(): number | null {
      if (toolExecutionActive) return null;
      return Date.now() - lastEventAt;
    },
    lastEventType: () => lastEventType,
  };
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
const USAGE_TELEMETRY_LOG_LIMIT = 3;

export async function sendAndWaitWithAbort(
  session: CopilotSession,
  prompt: MessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  let usageTelemetryLogCount = 0;
  // Delegates the "is this silence or a slow-but-healthy tool call"
  // determination to the shared execution-aware silence tracker (see its
  // doc comment above, and AGENTS.md's "Execution-aware silence tracking"
  // entry) instead of duplicating that bookkeeping here.
  const silenceTracker = createExecutionAwareSilenceTracker();
  const unsubscribeStallTracker = session.on((event: unknown) => {
    silenceTracker.recordEvent(event);
    if (!event || typeof event !== 'object' || !('type' in event)) return;
    const ev = event as Record<string, unknown>;

    // Important event: any tool the model actually invokes during the
    // turn (view, glob, bash, etc.), not just the forced target tool that
    // executeAuditSession's callback captures when the turn concludes.
    // Without this, only the final structured-output tool call showed up
    // in logs even though the model may have run several investigative
    // tool calls beforehand.
    if (ev.type === 'tool.execution_start') {
      const data = ev.data as Record<string, unknown> | undefined;
      const toolName = data?.toolName;
      // Per the SDK's ToolExecutionStartData type, `toolName` is a required
      // string -- this is an assumption about the SDK's wire shape, not
      // something we've validated ourselves. Rather than silently logging
      // "tool used: undefined" if that assumption is ever wrong (SDK
      // version change, malformed event, etc.), fail loudly so a broken
      // assumption is visible instead of masquerading as a real tool name.
      if (typeof toolName === 'string' && toolName.length > 0) {
        console.log(`[sendAndWaitWithAbort] tool used: ${toolName}`);
      } else {
        console.error(
          `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
          `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
          `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
        );
      }
    }

    // Important event: usage telemetry. This mirrors gateLoop.ts's own
    // usage-telemetry logging (issue #158), which never fires for auditor
    // sessions (PR review, spec audit, etc.) since they run through this
    // function instead of gateLoop's SSE event loop -- issue #180 noted
    // telemetry was "not active during PR review" for exactly this reason.
    if (
      (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
      usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
    ) {
      usageTelemetryLogCount++;
      if (ev.data && typeof ev.data === 'object') {
        console.log(`[UsageTelemetry] auditor session ${JSON.stringify(ev.data)}`);
      } else {
        console.error(
          `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
          `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
          `investigate before trusting this event's downstream handling.`,
        );
      }
    }
  });

  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setInterval(() => {
      // A tool is actively running -- `silentForMs()` returns null in that
      // case, since execution time is not "upstream silence" and must not
      // count against the stall budget. The clock effectively resumes
      // counting from whenever the tool finishes.
      const elapsed = silenceTracker.silentForMs();
      if (elapsed !== null && elapsed > STALL_TIMEOUT_MS) {
        if (stallTimer) clearInterval(stallTimer);
        // Unexpected path: log enough to tell a genuine stall apart from a
        // false positive (e.g. the watchdog racing an event that was about
        // to land) after the fact, without logging anything on the (vastly
        // more common) happy path.
        console.warn(
          `[sendAndWaitWithAbort] stall detected: no SDK event for ${elapsed}ms (threshold ${STALL_TIMEOUT_MS}ms); ` +
          `lastEventType=${silenceTracker.lastEventType() ?? 'none'}`,
        );
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
    resumeConfig: { availableTools?: string[]; tools?: unknown; provider?: ProviderConfig; systemMessage?: SessionConfig['systemMessage'] },
  ): Promise<void> => {
    let stallAttempt = 0;
    let currentPromptOpts = promptOpts;
    // Tracks whether we've already tried resuming the stalled session once
    // within the freshSessionConfig path. Per the design tradeoff in the
    // freshSessionConfig doc comment, a resume risks re-sending into a
    // wedged conversation -- but that risk is only real once we already
    // know the session is wedged. On the *first* stall we don't yet know
    // that, so we try a cheap resume (preserving history) before paying the
    // cost of a fresh, history-losing session. Only if the resume attempt
    // itself stalls do we treat the session as genuinely wedged and
    // escalate to createSession.
    let resumeAttempted = false;
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
        // Disconnect the stalled session before discarding it -- otherwise
        // each retry (via createSession or resumeSession) leaks a live
        // session/connection that nothing ever cleans up.
        try {
          await currentSession.disconnect?.();
        } catch(e) {
          // Best-effort: don't let disconnect failures mask the retry.
          console.warn(`[runForcedToolTurn] disconnect failed. ${e}`);
        }
        if (opts.freshSessionConfig) {
          // Only try the resume-first path if there's still budget left
          // afterward for the createSession fallback -- otherwise (e.g.
          // maxStallRetries: 1) the resume would consume the sole retry
          // slot and the fallback this caller opted into would never fire.
          // In that case, go straight to createSession on the only attempt.
          if (!resumeAttempted && stallAttempt < maxStallRetries) {
            console.warn(
              `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `attempting to resume the stalled session before falling back to a fresh one...`,
            );
            currentSession = await opts.client.resumeSession(currentSessionId, resumeConfig as SessionConfig);
            currentSessionId = currentSession.sessionId;
            opts.onSessionId?.(currentSessionId);
            resumeAttempted = true;
            // currentPromptOpts intentionally left as-is: resuming preserves
            // history, so we retry the exact in-flight prompt rather than
            // restarting from initialPrompt.
          } else {
            console.warn(
              `[runForcedToolTurn] resume attempt itself stalled (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `starting a new session and retrying the original prompt...`,
            );
            currentSession = await opts.client.createSession(opts.freshSessionConfig);
            currentSessionId = currentSession.sessionId;
            opts.onSessionId?.(currentSessionId);
            currentPromptOpts = { prompt: initialPrompt };
            resumeAttempted = false;
          }
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

  await sendWithStallRetry({ prompt: initialPrompt }, { tools: opts.tools, systemMessage: opts.freshSessionConfig?.systemMessage, ...(executionConfig.provider ? { provider: executionConfig.provider as ProviderConfig } : {}) });
  
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
      systemMessage: opts.freshSessionConfig?.systemMessage,
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

/**
 * Default hard timeout for `runForcedToolTurn`'s "no watchdog" successor,
 * `runForcedToolTurnUntilTimeout` -- see that function's doc comment. 60
 * minutes is generous headroom for a legitimately long, healthy,
 * reasoning-heavy turn (many chained tool calls) -- the exact case that
 * made the old stall watchdog's 90s-silence heuristic unreliable (see
 * `STALL_TIMEOUT_MS`'s doc comment and issues #188/#191).
 */
export const FORCED_TOOL_TURN_HARD_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Same options shape as `ForcedToolTurnOptions`, minus the stall-specific
 * knobs (`maxStallRetries`, `freshSessionConfig`) that don't apply here --
 * there is no stall detection or stall recovery in this function, so
 * nothing consumes them.
 *
 * `systemMessage` is re-added on top of that base shape (it is NOT part of
 * `freshSessionConfig` here, since there is no fresh-session path in this
 * function -- only `resumeSession`). Without it, the nudge-retry resume
 * path below has no way to carry the caller's curated system prompt across
 * `client.resumeSession()`, which silently falls back to the SDK's full
 * default `copilot-cli` system prompt for the remainder of the turn. This
 * is exactly the issue #208 regression: the original bug was that
 * `resumeSession()`'s `resumeConfig` didn't carry `systemMessage`, not that
 * the field itself was wrong, so the fix is to also pass it on resume.
 */
export type ForcedToolTurnUntilTimeoutOptions<T> = Omit<
  ForcedToolTurnOptions<T>,
  'maxStallRetries' | 'freshSessionConfig'
> & {
  systemMessage?: SessionConfig['systemMessage'];
};

/**
 * Successor to `runForcedToolTurn` for callers that don't need stall
 * recovery. Retired per issue #207: every investigated "stall" (PR #136,
 * and a subsequent PR-review session) turned out to be a slow-but-healthy
 * turn -- a long reasoning pass, or one chaining many tool calls --
 * misdiagnosed as a dead upstream connection, not an actual dead
 * connection. Issues #188/#191 patched the watchdog to tolerate silence
 * during active tool *execution*, but silence during model
 * reasoning/generation (the actual observed pattern, `lastEventType`
 * landing on `session.usage_info`) has no reliable SDK signal to
 * distinguish from a real stall, so the watchdog kept false-positiving on
 * it. Recovering from a false positive via `resumeSession()` also carries
 * its own cost independent of correctness: it re-injects the SDK's default
 * system message and busts the prompt cache (issue #208), making the
 * "recovered" turn slower and more expensive -- which can itself look like
 * a second stall.
 *
 * This function keeps the tool-not-called nudge/retry loop from
 * `runForcedToolTurn` unchanged, but replaces the idle-silence watchdog
 * and mid-turn stall-recovery ladder (resume-then-fresh-session) with a
 * single hard timeout racing `session.sendAndWait` directly -- if the SDK
 * hasn't resolved by `timeoutMs` (default `FORCED_TOOL_TURN_HARD_TIMEOUT_MS`),
 * the turn fails outright rather than being torn down and retried
 * mid-flight. No resume, no fresh session, no stall-specific retry budget.
 *
 * `runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`,
 * `isStallError`, and their existing tests are left in place, dormant, not
 * deleted -- see AGENTS.md. If a genuine (not turn-duration-driven) stall
 * is ever observed independently of this, that's the code to reach for
 * again.
 */
export async function runForcedToolTurnUntilTimeout<T>(
  session: CopilotSession,
  executionConfig: { provider?: unknown },
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  let currentSession = session;
  let currentSessionId = session.sessionId;
  const timeoutMs = opts.timeoutMs ?? FORCED_TOOL_TURN_HARD_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  let tracker = trackLastAssistantMessage(currentSession);
  // Same usage-telemetry logging sendAndWaitWithAbort does (issue #158,
  // #180). runForcedToolTurnUntilTimeout replaced runForcedToolTurn (and its
  // sendAndWaitWithAbort-based sends) as executeAuditSession's send path per
  // issue #207/#218, which carried over the tool-name logging below but
  // dropped this block -- silently regressing #180 for every auditor
  // session (PR review, spec audit, etc.) again (issue #228).
  let usageTelemetryLogCount = 0;

  const setupToolListener = (s: CopilotSession) => {
    const unsub = s.on((event: unknown) => {
      const ev = event as Record<string, unknown>;

      // Same diagnostic logging as sendAndWaitWithAbort (issue #180): log
      // every tool the model actually invokes during the turn, not just the
      // forced target tool, and fail loudly if the SDK's tool.execution_start
      // event doesn't have the expected string toolName -- otherwise a
      // broken assumption about the SDK's event contract would silently
      // masquerade as "tool used: undefined" instead of surfacing.
      if (ev.type === 'tool.execution_start') {
        const data = ev.data as Record<string, unknown> | undefined;
        const toolName = data?.toolName;
        if (typeof toolName === 'string' && toolName.length > 0) {
          console.log(`[runForcedToolTurnUntilTimeout] tool used: ${toolName}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
            `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
            `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (
        (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
        usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
      ) {
        usageTelemetryLogCount++;
        if (ev.data && typeof ev.data === 'object') {
          console.log(`[UsageTelemetry] auditor session ${JSON.stringify(ev.data)}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
            `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
            `investigate before trusting this event's downstream handling.`,
          );
        }
      }

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
   * Races the SDK's own `sendAndWait` against the caller's abort signal
   * only -- no idle-silence watchdog, no stall-tagged rejection, no
   * mid-turn resume. A hang here surfaces as the plain timeout/abort
   * rejection `sendAndWait` (or the abort listener) throws.
   */
  const sendUntilTimeout = async (promptOpts: MessageOptions): Promise<void> => {
    const racers: Promise<void>[] = [
      currentSession.sendAndWait(promptOpts, timeoutMs).then(() => undefined),
    ];
    if (opts.abortSignal) {
      racers.push(
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
          if (opts.abortSignal!.aborted) onAbort();
          else opts.abortSignal!.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  };

  await sendUntilTimeout({ prompt: initialPrompt } as MessageOptions);

  let lastAssistantText = tracker.getText();
  tracker.unsubscribe();
  unsubTool();

  let attempt = 0;

  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurnUntilTimeout] turn ended without ${toolNamesStr} being called ` +
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
      systemMessage: opts.systemMessage,
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

    const promptOpts: { prompt: string; tool_choice?: unknown } = { prompt: nudge, tool_choice: undefined as any };
    if (executionConfig.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendUntilTimeout(promptOpts as MessageOptions);

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
