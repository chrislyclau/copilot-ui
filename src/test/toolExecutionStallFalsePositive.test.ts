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

  it('reproduces the false-positive stall when a non-target tool runs longer than STALL_TIMEOUT_MS', async () => {
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
        // gap is the whole bug. `tool.execution_complete` (and the
        // resolution of sendAndWait itself) only arrives once the tool
        // actually finishes, well past STALL_TIMEOUT_MS.
        setTimeout(() => {
          eventHandler?.({ type: 'tool.execution_complete', data: { toolName: 'bash' } });
          resolve(undefined);
        }, TOOL_EXECUTION_DURATION_MS);
      })),
    } as any;

    const promise = sendAndWaitWithAbort(session, { prompt: 'hi' } as any, TOOL_EXECUTION_DURATION_MS + 60000);

    // Documents CURRENT (buggy) behavior: the watchdog has no notion of
    // "a tool is actively running" distinct from "the model has gone
    // silent", so it fires a false-positive stall partway through the
    // tool's legitimate execution.
    const assertion = expect(promise).rejects.toMatchObject({ isStall: true });
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
    await assertion;

    // TODO(bug): once sendAndWaitWithAbort's watchdog is made aware of
    // in-flight tool execution (issue #188/#191 -- suspend/extend the
    // stall clock between tool.execution_start and tool.execution_complete,
    // or apply a separate/larger timeout for that state), this should
    // instead resolve normally once the tool finishes, with no stall ever
    // raised. Swap the assertions above for the ones below once that fix
    // lands:
    //
    // await expect(promise).resolves.toBeUndefined();
    // await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_DURATION_MS + 60000);
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
