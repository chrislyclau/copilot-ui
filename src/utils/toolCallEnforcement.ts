import {
  CopilotSession,
  MessageOptions,
  SessionEventHandler,
} from '../copilotSdk/boundary';
import { SessionWrapper, SessionListenerEntry } from '../copilotSdk/sessionWrapper';

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
 * progress. Only applied when the caller's own `timeoutMs` already exceeds
 * STALL_TIMEOUT_MS -- i.e. they've already opted into a budget long enough
 * that the idle-based stall watchdog below is expected to be the real
 * governor.
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
 * silence: a slow-but-healthy tool must not be mistaken for a dead upstream
 * connection (issues #188/#191, reproduced on PR #136).
 *
 * Currently only consumed by the dormant `sendAndWaitWithAbort` stall
 * watchdog below. Pulled out as a standalone, documented utility so the
 * pattern is easy to find and reuse if a genuine stall is ever observed
 * independently of turn duration (issue #207). Callers feed events in via
 * `recordEvent`.
 */
export function createExecutionAwareSilenceTracker() {
  let lastEventAt = Date.now();
  let lastEventType: string | undefined;
  let toolExecutionActive = false;

  return {
    recordEvent(event: unknown): void {
      lastEventAt = Date.now();
      if (!event || typeof event !== 'object' || !('type' in event)) return;
      const ev = event as Record<string, unknown>;
      lastEventType = String(ev.type);
      if (ev.type === 'tool.execution_start') toolExecutionActive = true;
      if (ev.type === 'tool.execution_complete') toolExecutionActive = false;
    },
    silentForMs(): number | null {
      if (toolExecutionActive) return null;
      return Date.now() - lastEventAt;
    },
    lastEventType: () => lastEventType,
  };
}

/**
 * Races a `SessionWrapper`'s `sendAndWait` against an abort signal (as
 * before) *and* a stall watchdog: if no SDK event of any kind arrives for
 * STALL_TIMEOUT_MS, this rejects with a distinguishable `isStall`-tagged
 * error instead of silently waiting out the full `timeoutMs`. Does not
 * retry by itself -- callers (`runForcedToolTurn`) decide whether/how to
 * retry on a stall.
 *
 * Takes a `SessionWrapper` rather than a raw `CopilotSession` (issue #346):
 * the wrapper decides create-vs-resume internally, so the stall tracker's
 * listener is passed in as one of `SessionWrapper.sendAndWait`'s `listeners`
 * -- subscribed internally by the wrapper right after the (possibly
 * brand-new, on resume) underlying session is created, before the prompt is
 * sent, and unsubscribed by the wrapper itself once that call settles.
 * `onSessionId`, if supplied, fires the same way (SYS-REQ-028j: id only,
 * never the raw `CopilotSession`) -- callers needing their own per-session
 * setup (tool-call tracking, in `runForcedToolTurn` below) do so by passing
 * their own entries in `additionalListeners` instead of reading a session
 * reference inside a callback.
 *
 * NOTE on cleanup timing: because the wrapper only unsubscribes once its
 * *own* internal `session.sendAndWait()` settles, a stall-triggered rejection
 * here (the watchdog racer winning `Promise.race` below) does not itself
 * force earlier unsubscription -- this function's own `stallListener` stays
 * attached (still harmlessly recording events, not leaking, just not
 * silenced) until the abandoned turn's underlying SDK call eventually
 * settles on its own. That "harmless" characterization is specific to
 * `stallListener`, though: it does NOT extend to `additionalListeners`
 * forwarded in from a caller. If a caller's listener mutates state shared
 * across retries (as `runForcedToolTurn`'s tool-call/assistant-text
 * tracking below does), a belated event from the abandoned attempt can
 * mutate a later, live attempt's state -- see the attempt-id guard in
 * `runForcedToolTurn`'s listener closures below, which exists specifically
 * to neutralize this. The previous implementation unsubscribed immediately
 * on any race outcome; this is a minor behavior change traded for removing
 * all listener-lifetime bookkeeping from this function, matching #346's
 * simplified sendAndWait contract (nothing persists past one call, no
 * manual reattachment/cleanup needed by callers) -- but it does shift the
 * burden of staleness-safety for stateful listeners onto the caller.
 *
 * `timeoutMs` is intentionally NOT passed straight through to the SDK's own
 * sendAndWait deadline -- see SDK_HARD_TIMEOUT_CEILING_MS.
 */
const USAGE_TELEMETRY_LOG_LIMIT = 3;

export async function sendAndWaitWithAbort(
  wrapper: SessionWrapper,
  prompt: MessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onSessionId?: (sessionId: string) => void,
  additionalListeners?: SessionListenerEntry[],
): Promise<void> {
  let usageTelemetryLogCount = 0;
  const silenceTracker = createExecutionAwareSilenceTracker();

  const stallListener: SessionEventHandler = (event: unknown) => {
    silenceTracker.recordEvent(event);
    if (!event || typeof event !== 'object' || !('type' in event)) return;
    const ev = event as Record<string, unknown>;

    if (ev.type === 'tool.execution_start') {
      const data = ev.data as Record<string, unknown> | undefined;
      const toolName = data?.toolName;
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
  };

  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setInterval(() => {
      const elapsed = silenceTracker.silentForMs();
      if (elapsed !== null && elapsed > STALL_TIMEOUT_MS) {
        if (stallTimer) clearInterval(stallTimer);
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
    wrapper
      .sendAndWait(
        prompt,
        timeoutMs > STALL_TIMEOUT_MS ? Math.max(timeoutMs, SDK_HARD_TIMEOUT_CEILING_MS) : timeoutMs,
        [{ handler: stallListener }, ...(additionalListeners ?? [])],
        onSessionId,
      )
      .then(() => undefined),
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
    // No manual unsubscribe here anymore -- SessionWrapper.sendAndWait's own
    // `finally` unsubscribes `stallListener` once its internal call settles
    // (see the NOTE on cleanup timing above).
  }
}

export interface ForcedToolTurnOptions<T> {
  abortSignal?: AbortSignal;
  /** Wire-level provider identifier (e.g. `'openrouter'`), used only to decide whether to send an explicit `tool_choice` on a nudge retry. */
  provider?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  /**
   * The turn's full tool allowlist (as opposed to the narrower
   * `targetTools` allowlist a nudge-retry switches to). Used only to know
   * which construction-time tools to `disableTools()` before re-enabling
   * just `targetTools` on a nudge retry -- defaults to `targetTools` if
   * omitted. The wire-level tool schema itself is entirely owned by the
   * `SessionWrapper` the caller constructed and is never touched here
   * (SYS-REQ-028/028a).
   */
  availableTools?: string[];
  responseRequirements?: { toolCallExample?: string };
  /**
   * Caller-supplied event listeners, re-subscribed on every underlying send
   * this turn runs (the initial send, and each nudge or stall retry) --
   * mirrors `SessionWrapper.sendAndWait`'s own `listeners` parameter, since
   * that's where these are ultimately forwarded. Never hands back a raw
   * `CopilotSession` (SYS-REQ-028j): callers observe events, not sessions.
   */
  listeners?: SessionListenerEntry[];
  /**
   * How many times to retry after an upstream stall before giving up.
   * Tracked separately from `maxRetries`. Default 2.
   */
  maxStallRetries?: number;
  /**
   * When provided, a stall recovery whose first (resume-preserving-history)
   * attempt itself stalls abandons the wrapper it's holding and calls this
   * to construct a brand-new `SessionWrapper` instead of continuing to
   * resume -- replaces the pre-#346 `freshSessionConfig` option, which
   * created a second raw `CopilotSession` directly. Because a fresh
   * `SessionWrapper` has no conversation history, recovery always restarts
   * from `initialPrompt` rather than replaying whatever prompt was in
   * flight. If omitted, falls back to the wrapper's own internal resume
   * behavior (which does replay the exact in-flight prompt).
   */
  createFreshWrapper?: () => SessionWrapper;
  /**
   * Called with the id of every session this turn runs on, including ones
   * created mid-turn by stall recovery.
   */
  onSessionId?: (sessionId: string) => void;
}

/**
 * Detects whether a `tool.*` event matches one of `targetTools`, for the
 * shared tool-call-detection listener both forced-tool-turn functions below
 * install on every session they run on.
 */
function eventMatchesTargetTool(ev: Record<string, unknown>, targetTools: readonly string[]): boolean {
  return (
    (ev.type === 'tool.user_requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_start' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'external_tool.requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_complete' && (ev.data as any)?.toolCallId && targetTools.some(t => (ev.data as any).toolCallId === `call-${t}`)) ||
    (ev.type === 'tool.execution_complete' && targetTools.includes((ev.data as any)?.toolName))
  );
}

/**
 * Restricts `wrapper` to only `targetTools` being enabled among
 * `turnAvailableTools`, for a nudge retry (SYS-REQ-028c: enablement is a
 * private, permission-layer-only concept -- the wire-level schema itself is
 * never touched). `turnAvailableTools` is disabled first (as a superset that
 * includes `targetTools`), then `targetTools` is re-enabled.
 */
function restrictToTargetTools(wrapper: SessionWrapper, turnAvailableTools: readonly string[], targetTools: readonly string[]): void {
  wrapper.disableTools(...turnAvailableTools);
  wrapper.enableTools(...targetTools);
}

export async function runForcedToolTurn<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  let currentWrapper = wrapper;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const maxRetries = opts.maxRetries ?? 2;
  const maxStallRetries = opts.maxStallRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;

  // Bumped every time sendWithStallRetry starts a new attempt (including
  // stall retries). Captured by each attempt's listener closures below so a
  // belated event from an abandoned attempt -- its listeners stay attached
  // until SessionWrapper's own internal `sendAndWait` call settles, which
  // can be well after `sendAndWaitWithAbort` has already returned control
  // here on a stall -- can tell it's stale and no-op instead of mutating
  // `toolCalled`/`assistantText` for whatever attempt is live by then.
  let currentAttemptId = 0;
  let assistantText = '';
  const makeAttemptListeners = (attemptId: number) => ({
    textListener: (event: unknown): void => {
      if (attemptId !== currentAttemptId) return;
      if (!event || typeof event !== 'object') return;
      const ev = event as Record<string, unknown>;
      const evData = ev.data as Record<string, unknown> | undefined;
      if (ev.type === 'assistant.message') {
        assistantText += (evData?.content as string | undefined) || '';
      } else if (ev.type === 'assistant.message_delta') {
        assistantText += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
      }
    },
    toolListener: (event: unknown): void => {
      if (attemptId !== currentAttemptId) return;
      const ev = event as Record<string, unknown>;
      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
    },
  });
  const callerListeners = opts.listeners ?? [];

  const sendWithStallRetry = async (
    promptOpts: { prompt: string; tool_choice?: unknown },
  ): Promise<void> => {
    let stallAttempt = 0;
    let currentPromptOpts = promptOpts;
    let resumeAttempted = false;
    while (true) {
      currentAttemptId++;
      const { textListener, toolListener } = makeAttemptListeners(currentAttemptId);
      toolCalled = false;
      assistantText = '';
      try {
        await sendAndWaitWithAbort(
          currentWrapper,
          currentPromptOpts as MessageOptions,
          timeoutMs,
          opts.abortSignal,
          opts.onSessionId,
          [{ handler: toolListener }, { handler: textListener }, ...callerListeners],
        );
        return;
      } catch (err) {
        if (!isStallError(err)) {
          throw err;
        }
        if (toolCalled) {
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
        try {
          await currentWrapper.session?.disconnect?.();
        } catch (e) {
          console.warn(`[runForcedToolTurn] disconnect failed. ${e}`);
        }
        if (opts.createFreshWrapper) {
          if (!resumeAttempted && stallAttempt < maxStallRetries) {
            console.warn(
              `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `attempting to resume the stalled session before falling back to a fresh one...`,
            );
            resumeAttempted = true;
          } else {
            console.warn(
              `[runForcedToolTurn] resume attempt itself stalled (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `starting a new session and retrying the original prompt...`,
            );
            currentWrapper = opts.createFreshWrapper();
            currentPromptOpts = { prompt: initialPrompt };
            resumeAttempted = false;
          }
        } else {
          console.warn(
            `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
            `resuming session and retrying the same prompt...`,
          );
        }
      }
    }
  };

  await sendWithStallRetry({ prompt: initialPrompt });

  let lastAssistantText = assistantText;

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

    restrictToTargetTools(currentWrapper, turnAvailableTools, targetTools);

    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendWithStallRetry(promptOpts);

    lastAssistantText = assistantText || lastAssistantText;
  }

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

  return { result: finalResult as T, session: currentWrapper.session as CopilotSession, lastAssistantText, toolCalled };
}

/**
 * Default hard timeout for `runForcedToolTurn`'s "no watchdog" successor,
 * `runForcedToolTurnUntilTimeout`. 60 minutes is generous headroom for a
 * legitimately long, healthy, reasoning-heavy turn.
 */
export const FORCED_TOOL_TURN_HARD_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Same options shape as `ForcedToolTurnOptions`, minus the stall-specific
 * knobs (`maxStallRetries`, `createFreshWrapper`) that don't apply here --
 * there is no stall detection or stall recovery in this function.
 */
export type ForcedToolTurnUntilTimeoutOptions<T> = Omit<
  ForcedToolTurnOptions<T>,
  'maxStallRetries' | 'createFreshWrapper'
>;

/**
 * Successor to `runForcedToolTurn` for callers that don't need stall
 * recovery (issue #207). Keeps the tool-not-called nudge/retry loop
 * unchanged, but replaces the idle-silence watchdog and mid-turn
 * stall-recovery ladder with a single hard timeout racing
 * `wrapper.sendAndWait` directly.
 *
 * Takes a `SessionWrapper` instead of a raw `CopilotSession` +
 * `executionConfig` (issue #346): the wrapper owns the session's entire
 * lifecycle (create vs. resume), so this function's internal nudge-retry
 * calls `wrapper.sendAndWait(...)` and mutates the wrapper's enabled-tool
 * subset (`enableTools`/`disableTools`) instead of building a fresh
 * `SessionPolicy` per resume via `hardenedSession.ts` -- this module no
 * longer imports anything from there. The caller is responsible for
 * constructing and configuring the wrapper (tools, system prompt, model)
 * before passing it in.
 *
 * `runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`,
 * `isStallError`, and their existing tests are left in place, dormant, not
 * deleted -- see AGENTS.md.
 */
export async function runForcedToolTurnUntilTimeout<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? FORCED_TOOL_TURN_HARD_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;
  let usageTelemetryLogCount = 0;

  // Reset per attempt (see sendUntilTimeout below), not per session: plain
  // event handlers forwarded as `listeners`, subscribed/unsubscribed
  // internally by `SessionWrapper.sendAndWait` on every call (SYS-REQ-028j
  // -- no session reference held here).
  let assistantText = '';
  const textListener = (event: unknown): void => {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const evData = ev.data as Record<string, unknown> | undefined;
    if (ev.type === 'assistant.message') {
      assistantText += (evData?.content as string | undefined) || '';
    } else if (ev.type === 'assistant.message_delta') {
      assistantText += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
    }
  };
  const callerListeners = opts.listeners ?? [];

  const toolListener = (event: unknown): void => {
      const ev = event as Record<string, unknown>;

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

      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
  };

  const sendUntilTimeout = async (promptOpts: MessageOptions): Promise<void> => {
    toolCalled = false;
    assistantText = '';
    const racers: Promise<void>[] = [
      wrapper
        .sendAndWait(
          promptOpts,
          timeoutMs,
          [{ handler: toolListener }, { handler: textListener }, ...callerListeners],
          opts.onSessionId,
        )
        .then(() => undefined),
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

  let lastAssistantText = assistantText;

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

    restrictToTargetTools(wrapper, turnAvailableTools, targetTools);

    const promptOpts: { prompt: string; tool_choice?: unknown } = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendUntilTimeout(promptOpts as MessageOptions);

    lastAssistantText = assistantText || lastAssistantText;
  }

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

  return { result: finalResult as T, session: wrapper.session as CopilotSession, lastAssistantText, toolCalled };
}
