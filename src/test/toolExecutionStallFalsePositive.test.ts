import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAndWaitWithAbort, STALL_TIMEOUT_MS } from '../utils/toolCallEnforcement';

/**
 * sendAndWaitWithAbort's stall watchdog resets its "last event" clock on any
 * SDK event, but a long-running tool call is itself silent in between
 * `tool.execution_start` and `tool.execution_complete` -- there is no event
 * emitted while the tool is actually running. A model that legitimately
 * invokes a slow-but-healthy tool (e.g. `npx tsc`, `vitest`, a large `grep`)
 * for longer than STALL_TIMEOUT_MS will therefore have its turn killed and
 * restarted mid-investigation, exactly as seen on PR #136
 * (`lastEventType=session.usage_info` immediately after a burst of `bash`
 * calls).
 *
 * This suite reproduces that failure mode deterministically: a tool starts
 * executing, the underlying `sendAndWait` call is still legitimately
 * in-flight, and no further SDK events arrive until the tool finishes --
 * which here happens well past STALL_TIMEOUT_MS.
 */
describe('tool-execution silence misdiagnosed as stall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not false-positive stall when a non-target tool runs longer than STALL_TIMEOUT_MS', async () => {
    let eventHandler: ((event: unknown) => void) | undefined;
    const TOOL_EXECUTION_DURATION_MS = STALL_TIMEOUT_MS + 30000; // healthy, just slow

    const session = {
      sessionId: 'tool-exec-session',
      on: vi.fn().mockImplementation((handler: (event: unknown) => void) => {
        eventHandler = handler;
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(() => new Promise((resolve) => {
        // `tool.execution_start` fires immediately, mirroring the real SDK.
        eventHandler?.({ type: 'tool.execution_start', data: { toolName: 'bash' } });
        // Nothing else is emitted while the tool is running -- that silent
        // gap is fine now: the watchdog suspends its check for the duration
        // of `tool.execution_start` -> `tool.execution_complete`.
        setTimeout(() => {
          eventHandler?.({ type: 'tool.execution_complete', data: { toolName: 'bash' } });
          resolve(undefined);
        }, TOOL_EXECUTION_DURATION_MS);
      })),
    } as any;

    const promise = sendAndWaitWithAbort(session, { prompt: 'hi' } as any, TOOL_EXECUTION_DURATION_MS + 60000);

    // Fixed behavior (issue #188/#191): the watchdog now knows a tool is
    // actively running and suspends the silence check for that span, so no
    // stall is ever raised even though STALL_TIMEOUT_MS elapses mid-execution.
    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_DURATION_MS + 60000);
    await assertion;
  });

  it('does NOT false-positive when the tool finishes (and sendAndWait resolves) before STALL_TIMEOUT_MS', async () => {
    let eventHandler: ((event: unknown) => void) | undefined;
    const FAST_TOOL_DURATION_MS = STALL_TIMEOUT_MS - 20000;

    const session = {
      sessionId: 'tool-exec-session-fast',
      on: vi.fn().mockImplementation((handler: (event: unknown) => void) => {
        eventHandler = handler;
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(() => new Promise((resolve) => {
        eventHandler?.({ type: 'tool.execution_start', data: { toolName: 'bash' } });
        setTimeout(() => {
          eventHandler?.({ type: 'tool.execution_complete', data: { toolName: 'bash' } });
          resolve(undefined);
        }, FAST_TOOL_DURATION_MS);
      })),
    } as any;

    const promise = sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 300000);
    await vi.advanceTimersByTimeAsync(FAST_TOOL_DURATION_MS + 1000);
    await expect(promise).resolves.toBeUndefined();
  });
});
