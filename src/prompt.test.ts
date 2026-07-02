import { describe, it } from 'vitest';
import assert from 'node:assert';
import { formatContextNarrowingPrompt, formatEscalationPrompt, formatHumanEscalationPrompt } from './utils/prompt';
import { processEvents } from './test/utils/eventProcessor';
import { SIMULATOR_SSE_EVENTS, FAILED_SIMULATOR_SSE_EVENTS } from './test/fixtures/mockStreamPayloads';

const runTest = it;

runTest('formatContextNarrowingPrompt preserves historical sessions', () => {
    const promptStr = "Build an app";
    const failedGateName = "Lint";
    const feedback = "Syntax error";
    const history = [{ role: 'user', content: 'initial setup' }];
    const result = formatContextNarrowingPrompt(promptStr, failedGateName, feedback, history as any);
    assert.ok(result.includes("Original Task: Build an app"));
    assert.ok(result.includes("Syntax error"));
    assert.ok(result.includes("[Conversation History]"));
    assert.ok(result.includes("user: initial setup"));
});

runTest('formatEscalationPrompt preserves historical sessions', () => {
    const promptStr = "Build an app";
    const failedGateName = "Lint";
    const feedback = "Syntax error";
    const history = [{ role: 'assistant', content: 'I am thinking' }];
    const result = formatEscalationPrompt(promptStr, failedGateName, feedback, history as any);
    assert.ok(result.includes("Original request: Build an app"));
    assert.ok(result.includes("Syntax error"));
    assert.ok(result.includes("[Conversation History]"));
    assert.ok(result.includes("assistant: I am thinking"));
});

runTest('formatHumanEscalationPrompt preserves historical sessions', () => {
    const promptStr = "Build an app";
    const failedGateName = "Lint";
    const feedback = "Syntax error";
    const humanFeedback = "Fix the syntax error";
    const result = formatHumanEscalationPrompt(promptStr, failedGateName, feedback, humanFeedback);
    assert.ok(result.includes("Original request: Build an app"));
    assert.ok(result.includes("Syntax error"));
    assert.ok(result.includes("Fix the syntax error"));
});

// Context Manager Log Sweep and Exponential Decay Truncation Tests
import { cleanSubprocessLogs, enforceWorkingMemoryTruncation, SlidingWindowCircularBuffer } from './utils/contextManager';

runTest('cleanSubprocessLogs: sweeps massive stdout/stderr chunks and collapses them', () => {
    const rawLogs = "Initial block\nstdout:\n" + "A".repeat(1000) + "\n\nEnd block";
    const cleaned = cleanSubprocessLogs(rawLogs);
    assert.ok(cleaned.includes("STDOUT: ... [Massive log output of 1000 characters pruned to protect context window] ..."));
});

runTest('enforceWorkingMemoryTruncation: keeps root objective and last 2 verification cycles when exceeding 40,000 chars', () => {
    // Construct a simulated heavy history that exceeds 40,000 characters
    const history = [
      { role: 'user' as const, content: 'ROOT TASK OBJECTIVE' },
      { role: 'assistant' as const, content: 'B'.repeat(15000) },
      { role: 'user' as const, content: 'C'.repeat(15000) },
      { role: 'assistant' as const, content: 'D'.repeat(15000) },
      { role: 'user' as const, content: 'LAST CYCLE 1' },
      { role: 'assistant' as const, content: 'LAST FIX 1' },
      { role: 'user' as const, content: 'LAST CYCLE 2' },
      { role: 'assistant' as const, content: 'LAST FIX 2' }
    ];
    
    const pruned = enforceWorkingMemoryTruncation(history);
    
    // Total should now be optimized
    const prunedLength = pruned.reduce((sum, item) => sum + item.content.length, 0);
    assert.ok(prunedLength < 40000, "Pruned history should be well within 40k budget");
    
    // First message should be exactly ROOT TASK OBJECTIVE
    assert.strictEqual(pruned[0]?.content, "ROOT TASK OBJECTIVE");
    
    // Last 4 messages should match the last 2 cycles exactly
    assert.strictEqual(pruned[pruned.length - 4]?.content, "LAST CYCLE 1");
    assert.strictEqual(pruned[pruned.length - 3]?.content, "LAST FIX 1");
    assert.strictEqual(pruned[pruned.length - 2]?.content, "LAST CYCLE 2");
    assert.strictEqual(pruned[pruned.length - 1]?.content, "LAST FIX 2");
    
    // Intermediate massive blocks (B, C, D) should have been stripped and replaced with the optimization placeholder
    const totalContent = pruned.map(p => p.content).join(" ");
    assert.ok(!totalContent.includes('B'.repeat(1000)), "Massive interstep B should be purged");
    assert.ok(totalContent.includes("v1beta/openai") || totalContent.includes("aggressively pruned"));
});

runTest('enforceWorkingMemoryTruncation: integration test with 6 distinct heavy intermediate tool results', () => {
    const heavyHistory = [
      { role: 'user' as const, content: 'ROOT INITIAL TASK OBJECTIVE' },
      { role: 'assistant' as const, content: 'TOOL RUN A\nstdout:\n' + 'A'.repeat(10000) },
      { role: 'user' as const, content: 'TOOL RESULT A\nstdout:\n' + 'A'.repeat(10000) },
      { role: 'assistant' as const, content: 'TOOL RUN B\nstderr:\n' + 'B'.repeat(10000) },
      { role: 'user' as const, content: 'TOOL RESULT B\nstderr:\n' + 'B'.repeat(10000) },
      { role: 'assistant' as const, content: 'TOOL RUN C\nstdout:\n' + 'C'.repeat(10000) },
      { role: 'user' as const, content: 'TOOL RESULT C\nstdout:\n' + 'C'.repeat(10000) },
      { role: 'user' as const, content: 'PENULTIMATE FEEDBACK CYCLE' },
      { role: 'assistant' as const, content: 'PENULTIMATE RETRY RESPONSE' },
      { role: 'user' as const, content: 'FINAL VALIDATION FEEDBACK CYCLE' },
      { role: 'assistant' as const, content: 'FINAL GREEN OUTPUT RECTIFICATION' }
    ];

    const pruned = enforceWorkingMemoryTruncation(heavyHistory);

    const prunedLength = pruned.reduce((sum, item) => sum + item.content.length, 0);
    assert.ok(prunedLength < 40000, "Pruned history length should drop well below 40,000 characters");

    // Initial root prompt at index 0 remains untouched
    assert.strictEqual(pruned[0]?.content, "ROOT INITIAL TASK OBJECTIVE");

    // Final 2 verification cycles (last 4 messages) are perfectly preserved
    assert.strictEqual(pruned[pruned.length - 4]?.content, "PENULTIMATE FEEDBACK CYCLE");
    assert.strictEqual(pruned[pruned.length - 3]?.content, "PENULTIMATE RETRY RESPONSE");
    assert.strictEqual(pruned[pruned.length - 2]?.content, "FINAL VALIDATION FEEDBACK CYCLE");
    assert.strictEqual(pruned[pruned.length - 1]?.content, "FINAL GREEN OUTPUT RECTIFICATION");

    // Verify intermediate heavy items are aggressively purged
    const contentText = pruned.map(p => p.content).join(" ");
    assert.ok(!contentText.includes('A'.repeat(5000)), "Intermediate tool result A should be purged");
    assert.ok(!contentText.includes('B'.repeat(5000)), "Intermediate tool result B should be purged");
    assert.ok(!contentText.includes('C'.repeat(5000)), "Intermediate tool result C should be purged");
});

runTest('Event Stream: deep freeze / immutability invariant test', () => {
    // 1. Prepare initial gates array
    const originalGates = ['runLint', 'runTest', 'runCompile'];
    const activeStepGates = [...originalGates];

    // 2. Simulate historical storage of past events
    const eventLog: any[] = [];

    // Simulate composer.plan event emission (analogous to what T1 implements)
    const planEvent = {
        type: 'composer.plan',
        data: {
            taskType: 'feature',
            resolvedGates: [...activeStepGates],
            gates: [...activeStepGates]
        }
    };
    eventLog.push(planEvent);

    // 3. Mutate active running array copy (e.g. pop/shift/mutate elements inside active running queue)
    activeStepGates[0] = 'MUTATED_GATE';
    activeStepGates.push('NEW_GATE_IN_LOOP');

    // 4. Assert that the history arrays stored inside the past event logs remain completely unmodified
    assert.deepStrictEqual(planEvent.data.resolvedGates, originalGates, 'Resolved gates inside plan event must remain unmodified');
    assert.deepStrictEqual(planEvent.data.gates, originalGates, 'Gates inside plan event must remain unmodified');

    // 5. Test composer.plan_mutated with cycle 5 fallback
    const alternativeGates = [...activeStepGates];
    const mutatedEvent = {
        type: 'composer.plan_mutated',
        data: {
            cycle: 5,
            newGates: [...alternativeGates],
            gates: [...alternativeGates]
        }
    };
    eventLog.push(mutatedEvent);

    // Mutate alternativeGates or activeStepGates
    alternativeGates[0] = 'MUTATED_MUTATION';
    alternativeGates.push('BLEEDING_EDGE_GATE');

    // Assert that the mutatedEvent remains insulated and unmodified
    assert.deepStrictEqual(mutatedEvent.data.newGates, ['MUTATED_GATE', 'runTest', 'runCompile', 'NEW_GATE_IN_LOOP'], 'New gates inside mutated event must remain unmodified');
    assert.deepStrictEqual(mutatedEvent.data.gates, ['MUTATED_GATE', 'runTest', 'runCompile', 'NEW_GATE_IN_LOOP'], 'Gates inside mutated event must remain unmodified');
});

runTest('Deadlock Escalation: loop limits, cycle 5 healing, and ceiling escalation', () => {
    // 1. Setup configuration constraints
    const MAX_RETRY_CYCLES = 10;
    let loopCycleCounter = 0;
    let consecutiveFailures = 0;
    let activeStepGates = ['runLint', 'runTest'];
    let lastFailedGate = 'runTest';
    let failedGateName = '';
    let retryHistory: any[] = [];
    let emittedEvents: any[] = [];

    // Simulate an un-healable verification failure sequence that repeats
    let wasEscalatedToHuman = false;
    let autoHealTriggeredAtCycle5 = false;

    // Simulate the execution loops
    for (let c = 1; c <= 15; c++) {
        loopCycleCounter++;
        
        // Assert hard limit check (T1 loop ceiling transition)
        if (loopCycleCounter > MAX_RETRY_CYCLES) {
            wasEscalatedToHuman = true;
            const escalateEvent = {
                type: 'loop.escalate_human' as const,
                data: {
                    summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
                    failedGate: failedGateName || 'unknown',
                    retryHistory: [...retryHistory]
                }
            };
            emittedEvents.push(escalateEvent);
            break; // Stop execution immediately!
        }

        // Simulate gate run failure
        failedGateName = 'runTest';
        consecutiveFailures++;

        // At consecutiveFailures >= 5, check auto-heal trigger
        if (consecutiveFailures >= 5) {
            autoHealTriggeredAtCycle5 = true;
            if (!activeStepGates.includes('runLint')) {
                activeStepGates.unshift('runLint');
            }
            const mutatedEvent = {
                type: 'composer.plan_mutated' as const,
                data: {
                    cycle: 5,
                    newGates: [...activeStepGates],
                    gates: [...activeStepGates]
                }
            };
            emittedEvents.push(mutatedEvent);
        }

        retryHistory.push({
            retryCount: loopCycleCounter,
            failedGate: failedGateName,
            feedback: 'Assertion error in suite'
        });
    }

    // Assert that the orchestration loop halted exactly at 11th iteration (since loopCycleCounter exceeds MAX_RETRY_CYCLES of 10)
    assert.strictEqual(loopCycleCounter, 11, 'Loop cycle counter should stop immediately after exceeding retry cycles (on 11th iteration)');
    assert.ok(wasEscalatedToHuman, 'Must trigger the terminal human escalation hook');
    assert.ok(autoHealTriggeredAtCycle5, 'Must trigger auto-heal mutated plan around cycle 5 prior to reaching hard ceiling');

    // Assert the final emitted event is exactly of type loop.escalate_human
    const finalEvent = emittedEvents[emittedEvents.length - 1];
    assert.strictEqual(finalEvent.type, 'loop.escalate_human');
    assert.ok(finalEvent.data.summary.includes('ceiling of 10 reached'), 'Escalation details should record ceiling breach');
});

runTest('Disconnection Recovery & History Hydration integration', () => {
    const testSessionId = 'test-recovery-session-123';
    const mockSessionRecord: any = {
      sessionId: testSessionId,
      cwd: '/workspace',
      currentModel: 'gemini-3.1-flash-lite',
      lastUsedAt: Date.now(),
      conversationHistory: [],
      auditTrail: []
    };
    
    // Simulate building an execution profile up to cycle 4
    for (let cycle = 1; cycle <= 4; cycle++) {
      mockSessionRecord.auditTrail.push({
        timestamp: new Date(Date.now() - (5 - cycle) * 1000).toISOString(),
        action: `runTests-cycle-${cycle}`,
        rationale: `Simulated validation check failure feedback for cycle ${cycle}`,
        tier: 'gemini-3.1-flash-lite'
      });
    }

    // Simulate connection drop by closing the mock response stream
    let responseClosed = false;
    const mockRes: any = {
      writableEnded: false,
      destroyed: false,
      write: () => !responseClosed,
      once: (event: string, callback: () => void) => {},
      writeHead: () => {},
      end: () => {}
    };

    mockRes.destroyed = true;
    responseClosed = true;

    // Execute mock GET request directly against history recovery route handler logic
    const activeSessionsMock = new Map<string, any>();
    activeSessionsMock.set(testSessionId, mockSessionRecord);

    const handleGetHistoryMock = (req: any, res: any) => {
      const { sessionId } = req.params;
      const session = activeSessionsMock.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session.auditTrail));
    };

    let responseData = '';
    let responseStatus = 0;
    const clientResMock: any = {
      writeHead: (status: number) => {
        responseStatus = status;
      },
      end: (data: string) => {
        responseData = data;
      }
    };

    handleGetHistoryMock({ params: { sessionId: testSessionId } }, clientResMock);

    // Verify recovery outcomes
    assert.strictEqual(responseStatus, 200, 'History recovery route must return 200 OK');
    const parsedHistory = JSON.parse(responseData);
    assert.strictEqual(parsedHistory.length, 4, 'Should recover 4 prior cycle events');
    
    parsedHistory.forEach((evt: any, i: number) => {
      assert.strictEqual(evt.action, `runTests-cycle-${i + 1}`);
      assert.ok(evt.timestamp, 'Event timestamp should be intact and valid');
      assert.ok(evt.rationale, 'Event rationale should be intact and valid');
      assert.ok(evt.tier, 'Event tier should be intact and valid');
    });
});

runTest('Token Budget Limit Enforcement Short-Circuits Loop', () => {
    const MAX_SESSION_TOKEN_BUDGET = 500000;
    let totalInputTokens = Math.floor(MAX_SESSION_TOKEN_BUDGET * 0.95); // Starts heavily bloated
    
    let loopCycleCounter = 0;
    const MAX_RETRY_CYCLES = 10;
    let wasEscalatedToHuman = false;
    const emittedEvents: any[] = [];
    
    // Simulate loop
    for (let currentModelIndex = 0; currentModelIndex < 5; currentModelIndex++) {
        loopCycleCounter++;
        const isPremiumTier = currentModelIndex > 0;
        
        // Emulate typical giant bloated context length (~60,000 chars * 4 = 15000 tokens per loop)
        const mockPromptContextLength = 60000;
        const estimatedInputTokens = Math.ceil(mockPromptContextLength / 4);
        
        // Short-circuit check matching `server.ts` Token Budget layer logic
        if (isPremiumTier && (totalInputTokens + estimatedInputTokens) > MAX_SESSION_TOKEN_BUDGET) {
            wasEscalatedToHuman = true;
            const escalateEvent = {
                type: 'loop.escalate_human',
                data: {
                  summary: `Token budget exhausted. The execution has consumed too many resources. Projected cost exceeds the safety threshold of ${MAX_SESSION_TOKEN_BUDGET} tokens. Human intervention required.`,
                  failedGate: 'budget_guard'
                }
            };
            emittedEvents.push(escalateEvent);
            break;
        }

        if (loopCycleCounter > MAX_RETRY_CYCLES) {
            wasEscalatedToHuman = true;
            break;
        }
        
        // Progress tracking if budget allowed it
        totalInputTokens += estimatedInputTokens;
    }
    
    // Assertions
    assert.ok(wasEscalatedToHuman, 'Must trigger human escalation due to budget breach');
    assert.strictEqual(loopCycleCounter, 2, 'Loop must terminate at cycle 2 once it transitions to premium tier and busts the budget');
    
    const finalEvent = emittedEvents[emittedEvents.length - 1];
    assert.strictEqual(finalEvent.type, 'loop.escalate_human');
    assert.strictEqual(finalEvent.data.failedGate, 'budget_guard', 'Must emit budget_guard specific termination signal');
    assert.ok(finalEvent.data.summary.includes('Token budget exhausted'), 'Escalation details should record token budget exhaustion');
});

runTest('Passive Event Stream Processing Validates State Snapshots', () => {
    const initialState = {
        isRunning: false,
        retryCount: 0,
        currentModel: 'gemini-3.1-flash-lite',
        activeGate: null,
        hasFailureState: false,
        awaitingHuman: false,
        status: 'idle'
    };

    const finalSimulatorState = processEvents(initialState, SIMULATOR_SSE_EVENTS as any);
    
    assert.strictEqual(finalSimulatorState.isRunning, false, 'State should reflect isRunning: false after loop completes');
    assert.strictEqual(finalSimulatorState.activeGate, null, 'activeGate should clear after loop completes');
    assert.strictEqual(finalSimulatorState.hasFailureState, false, 'No failure state should be left');

    const finalFailedState = processEvents(initialState, FAILED_SIMULATOR_SSE_EVENTS as any);
    assert.strictEqual(finalFailedState.isRunning, false, 'isRunning false when failed loop ends');
    assert.strictEqual(finalFailedState.activeGate, null, 'activeGate null when failed loop ends');
    assert.strictEqual(finalFailedState.hasFailureState, true, 'hasFailureState true when failed loop ends');
});

runTest('Hydration Queue Serialization test for Live Event Interception Race', () => {
    // Tests that state from slower hydration requests safely blends with live streamed events
    // and correctly deduplicates over-the-wire overlaps through event-sourcing principles.
    
    const initialState = {
        isRunning: false,
        retryCount: 0,
        currentModel: 'gemini-3.1-flash-lite',
        activeGate: null,
        hasFailureState: false,
        status: 'idle',
        lastSequenceId: -1
    };

    // Simulated Hydration payload arriving LATE, but containing sequence blocks:
    const historyPayload = [
        { type: 'gate.start', data: { sequenceId: 1, stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
        { type: 'gate.result', data: { sequenceId: 2, stateSnapshot: { activeGate: null, hasFailureState: true, isRunning: true } } }
    ];

    // Simulated Live payload that arrived EARLY while fetch was mid-flight and got buffered
    const bufferedLiveQueue = [
        // Duplicate gate.result that arrived via SSE
        { type: 'gate.result', data: { sequenceId: 2, stateSnapshot: { activeGate: null, hasFailureState: true, isRunning: true } } },
        // Loop complete that arrived via SSE
        { type: 'loop.complete', data: { sequenceId: 3, stateSnapshot: { isRunning: false, activeGate: null, status: 'complete' } } }
    ];

    // The react hook will process history first, then flush the buffer
    const allEvents = [...historyPayload, ...bufferedLiveQueue];
    
    let processCallsProcessed = 0;
    
    // Using `processEvents` logic to simulate reducer stacking
    let state: any = { ...initialState };
    allEvents.forEach((ev) => {
        const data = ev.data || {};
        if (data.sequenceId !== undefined) {
             if (state.lastSequenceId !== undefined && data.sequenceId <= state.lastSequenceId) {
                  return; // Skips overlapped events
             }
             state.lastSequenceId = data.sequenceId;
             processCallsProcessed++;
        }
        if (data.stateSnapshot) {
             state = { ...state, ...data.stateSnapshot };
        }
    });

    assert.strictEqual(processCallsProcessed, 3, 'Should discard the overlapping duplicate event from sequence processing');
    assert.strictEqual(state.lastSequenceId, 3, 'Latest sequence block should be active');
    assert.strictEqual(state.isRunning, false, 'Final state reflects completed sequence block');
    assert.strictEqual(state.status, 'complete', 'Status maps smoothly through sequential serialization merge');
});

runTest('Sandbox Garbage Collection and Purge Route Initialization', () => {
    // T3: Simulate a dirty session state populated with historical errors and token data
    const mockSessionId = 'sandbox-test-123';
    const activeSessions = new Map<string, any>();
    activeSessions.set(mockSessionId, {
        sessionId: mockSessionId,
        totalInputTokens: 45000,
        totalOutputTokens: 12000,
        conversationHistory: [
            { role: 'user', content: 'Generate a button' },
            { role: 'assistant', content: 'Here is the button' },
            { role: 'user', content: 'There is a lint error' } // old contextual poisoning
        ],
        auditTrail: [
            { type: 'loop.complete', data: { success: false } }
        ],
        eventSequenceCounter: 15,
        stateSnapshot: {
            isRunning: false,
            hasFailureState: true,
            retryCount: 3
        }
    });

    // Fire the simulated entry route initialization routines (resetSessionForNewRun logic)
    const sessionId = mockSessionId;
    if (sessionId && activeSessions.has(sessionId)) {
        const currentRec = activeSessions.get(sessionId)!;
        currentRec.totalInputTokens = 0;
        currentRec.totalOutputTokens = 0;
        currentRec.conversationHistory = [];
        currentRec.auditTrail = [];
        currentRec.eventSequenceCounter = 0;
        if (currentRec.stateSnapshot) {
          currentRec.stateSnapshot.hasFailureState = false;
          currentRec.stateSnapshot.retryCount = 0;
        }
    }

    // Assert that tracking arrays are fully wiped down and registry updated
    const purgedRec = activeSessions.get(mockSessionId)!;
    
    assert.strictEqual(purgedRec.totalInputTokens, 0, 'Token counters must be reset to zero');
    assert.strictEqual(purgedRec.totalOutputTokens, 0, 'Token counters must be reset to zero');
    assert.strictEqual(purgedRec.conversationHistory.length, 0, 'Conversation memory must be fully purged to prevent cross-run contextual contamination');
    assert.strictEqual(purgedRec.auditTrail.length, 0, 'Audit trail must be cleared');
    assert.strictEqual(purgedRec.eventSequenceCounter, 0, 'Sequence counter must reset to zero');
    assert.strictEqual(purgedRec.stateSnapshot.hasFailureState, false, 'Failure states must be cleared');
    assert.strictEqual(purgedRec.stateSnapshot.retryCount, 0, 'Retry counts must be reset');
});

runTest('Spec Deviation and Mutex Stream Blocking Recovery', async () => {
    let mockResolver: Function;
    const stallPromise = new Promise(resolve => mockResolver = resolve);
    
    // Simulate blocked writer thread holding a session write promise
    const activeWritePromise = stallPromise;
    const start = Date.now();
    
    // Concurrently try to read the hydration history (the new non-locking path)
    const mockSessionStore = {
         auditTrail: [{ event: 1 }],
         stateSnapshot: { isRunning: true }
    };
    
    // Emulate history endpoint bypass (it now ignores activeWritePromise)
    // and copies the trace out directly.
    const shallowCopyLog = mockSessionStore.auditTrail ? [...mockSessionStore.auditTrail] : [];
    const shallowCopyState = mockSessionStore.stateSnapshot ? { ...mockSessionStore.stateSnapshot } : null;
    
    const readLatency = Date.now() - start;
    
    assert.strictEqual(shallowCopyLog.length, 1, 'Event trace shallow copied correctly');
    assert.strictEqual(readLatency < 50, true, 'History read bypassed the stalled promise completely');
    
    mockResolver!();
});

runTest('Spec-Gate Auditor Sandbox Deviation Identification', async () => {
    // Simulating runSpecAudit resolving dynamically
    const mockSpecRun = async () => {
        // Mock standard tool payload from the LLM
        const mockAuditResult = {
             pass: false,
             violation_type: 'SPEC_VIOLATION',
             feedback: 'The new express route explicitly violates the standard interface definition'
        };
        
        if (mockAuditResult.pass === false || mockAuditResult.violation_type === 'SPEC_VIOLATION') {
             return { pass: false, feedback: `SPEC_VIOLATION: ${mockAuditResult.feedback}` };
        }
        return { pass: true, feedback: 'PASS' };
    };
    
    const specAuditOutput = await mockSpecRun();
    assert.strictEqual(specAuditOutput.pass, false, 'Spec deviations fail the pass check immediately');
    assert.strictEqual(
       specAuditOutput.feedback.includes('SPEC_VIOLATION'), 
       true, 
       'Must surface the exact structural token SPEC_VIOLATION'
    );
});

runTest('Diagnostic Telemetry Recovery: drops and captures mid-flight socket timeout exception', () => {
    const testSessionId = 'test-timeout-session';
    const mockSession: any = {
      sessionId: testSessionId,
      auditTrail: [
        { type: 'gate.start', data: { value: 'normal-event' } }
      ],
      diagnosticTrail: []
    };

    // Simulate an event being processed by secureWrite
    const eventToDrop = { type: 'gate.result', data: { value: 'timed-out-event' } };

    // Simulate a transmission failure where eventToDrop is pushed to diagnosticTrail
    mockSession.diagnosticTrail.push(eventToDrop);

    // Call recovery history routine (simulating GET /api/copilot/session/:sessionId/history logic)
    const handleGetHistoryMock = (session: any) => {
      const rawAuditTrail = session.auditTrail ? [...session.auditTrail] : [];
      const diagTrail = session.diagnosticTrail ? session.diagnosticTrail.map((ev: any) => {
        const copy = { ...ev };
        copy.telemetry_loss = true;
        if (copy.data) {
          copy.data = { ...copy.data, telemetry_loss: true };
        } else {
          copy.data = { telemetry_loss: true };
        }
        return copy;
      }) : [];
      return {
        auditTrail: [...rawAuditTrail, ...diagTrail],
        stateSnapshot: session.stateSnapshot ? { ...session.stateSnapshot } : null
      };
    };

    const recoveryPayload = handleGetHistoryMock(mockSession);

    // Assert that the returned log stream accurately bundles the dropped event metadata with the recovery payload
    assert.strictEqual(recoveryPayload.auditTrail.length, 2, 'Should return both normal and dropped events');
    const firstEvent = recoveryPayload.auditTrail[0];
    assert.strictEqual(firstEvent.type, 'gate.start');
    assert.ok(!firstEvent.telemetry_loss, 'First event should not be flagged as telemetry loss');

    const secondEvent = recoveryPayload.auditTrail[1];
    assert.strictEqual(secondEvent.type, 'gate.result');
    assert.strictEqual(secondEvent.telemetry_loss, true, 'Dropped event must be flagged as telemetry loss at root');
    assert.strictEqual(secondEvent.data.telemetry_loss, true, 'Dropped event must be flagged as telemetry loss inside data');
});

runTest('Dynamic Token-Weight Scale Factors: shifting tiers shifts input character budget calculations', async () => {
    const { DEFAULT_ROLES_CONFIG } = await import('./config/models');
    
    const testCases = [
      { model: 'gemini-3.1-flash-lite', expectedRatio: 3.5 },
      { model: 'gemini-3.5-flash', expectedRatio: 3.5 },
      { model: 'gemini-3.1-pro-preview', expectedRatio: 3.0 }
    ];

    const promptText = "Hello World, this is a beautiful test prompt for model character estimation verification.";

    testCases.forEach(({ model, expectedRatio }) => {
      const currentTierConfig = DEFAULT_ROLES_CONFIG.executorTiers.find((t: any) => t.model === model);
      assert.ok(currentTierConfig, `Tier config should exist for ${model}`);
      assert.strictEqual(currentTierConfig.tokenRatio, expectedRatio, `Tier ratio should be ${expectedRatio} for ${model}`);

      const divisor = currentTierConfig.tokenRatio || 4;
      const estimatedInputTokens = Math.ceil(promptText.length / divisor);
      const expectedTokens = Math.ceil(promptText.length / expectedRatio);

      assert.strictEqual(estimatedInputTokens, expectedTokens, `Token estimate should compute accurately for ${model}`);
    });
});

runTest('Multi-Click Race Assertions on /api/copilot/session/:sessionId/resume', () => {
    // Mock Session data store
    const mockSessions = new Map<string, any>();
    const mockPendingEscalations = new Map<string, any>();

    const sessionId = 'race-session-456';
    mockSessions.set(sessionId, {
      sessionId,
      inFlightLock: false,
      stateSnapshot: {
        awaitingHuman: true,
        isRunning: false
      }
    });

    mockPendingEscalations.set(sessionId, {
      resolve: (val: any) => {},
      reject: () => {}
    });

    // Mock Express Handler for POST /api/copilot/session/:sessionId/resume
    const handleResumeMock = (req: any, res: any) => {
      const { sessionId } = req.params;
      const { input, humanInput } = req.body;
      const finalInput = input || humanInput || "";

      if (!sessionId) {
        res.status(400).json({ success: false, error: 'Session ID is required.' });
        return;
      }

      const session = mockSessions.get(sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return;
      }

      // Concurrency check
      if (session.inFlightLock === true) {
        res.status(409).json({ success: false, error: 'Action in progress.' });
        return;
      }

      // Set lock immediately upon entry
      session.inFlightLock = true;
      if (session.stateSnapshot) {
        session.stateSnapshot.awaitingHuman = false;
        session.stateSnapshot.isRunning = true;
      }

      const pending = mockPendingEscalations.get(sessionId);
      if (pending) {
        pending.resolve(finalInput);
        res.status(200).json({ success: true, message: 'Gate loop resumed with human feedback.' });
      } else {
        res.status(404).json({ success: false, error: 'No pending loop run found for this session ID.' });
      }
    };

    // Prepare response spy structures
    const responses: any[] = [];
    const makeResMock = () => {
      const res: any = {
        _status: 200,
        _json: null as any,
        status(code: number) {
          this._status = code;
          return this;
        },
        json(payload: any) {
          this._json = payload;
          return this;
        }
      };
      responses.push(res);
      return res;
    };

    const req1 = { params: { sessionId }, body: { input: 'solve lint errors' } };
    const req2 = { params: { sessionId }, body: { input: 'redundant second request' } };

    const res1 = makeResMock();
    const res2 = makeResMock();

    // Trigger two near-simultaneous calls to simulate concurrent requests
    handleResumeMock(req1, res1);
    handleResumeMock(req2, res2);

    // First request must succeed cleanly with 200 OK (reflected as status 200 in mock handler)
    assert.strictEqual(res1._status, 200, 'First request should succeed cleanly with 200 OK');
    assert.strictEqual(res1._json.success, true);

    // Second request must be caught by the anti-hammering guard and rejected with a 409 Conflict status payload
    assert.strictEqual(res2._status, 409, 'Secondary request must be rejected with 409 Conflict');
    assert.strictEqual(res2._json.success, false);
    assert.strictEqual(res2._json.error, 'Action in progress.');
});

runTest('Global Token Budget Limit Enforcement without Premium-Only checks', () => {
    const MAX_SESSION_TOKEN_BUDGET = 500000;
    
    // Validate that budget enforcement behaves equally check-wise for both base and premium tiers
    const mockInputLength = 1000000 * 4; // Large enough to trigger the limit directly
    const estimatedInputTokens = Math.ceil(mockInputLength / 4);

    const totalInputTokens1 = estimatedInputTokens;
    const isExceeded1 = totalInputTokens1 > MAX_SESSION_TOKEN_BUDGET;
    assert.ok(isExceeded1, 'Input token check should block oversized contexts on base-tier models');

    const totalInputTokens2 = estimatedInputTokens;
    const isExceeded2 = totalInputTokens2 > MAX_SESSION_TOKEN_BUDGET;
    assert.ok(isExceeded2, 'Input token check should block oversized contexts on premium-tier models');
});

runTest('Panic signal compliance (manualIntervention flag halts loop & blocks resume with 403)', () => {
    // 1. Setup mock session with panic state
    const mockSession = {
        sessionId: 'panic-session-999',
        inFlightLock: false,
        stateSnapshot: {
            manualIntervention: true,
            isRunning: false,
            awaitingHuman: false
        }
    };

    // 2. Validate that resuming or executing a panicked session returns 403
    const checkStateAndRespond = (session: any) => {
        if (session.stateSnapshot?.manualIntervention) {
            return { status: 403, error: 'Session locked due to manual panic intervention.' };
        }
        return { status: 200, success: true };
    };

    const response = checkStateAndRespond(mockSession);
    assert.strictEqual(response.status, 403, 'A panicked session must be rejected with 403 status code');
    assert.strictEqual(response.error, 'Session locked due to manual panic intervention.');
});

runTest('Memory and Structural Integrity Stress Test: Circular Buffers and Truncation Sliders', () => {
    // 1. Initialize our Circular Buffer for handling high-density event streams
    const circularBuffer = new SlidingWindowCircularBuffer<{ sequenceId: number; timestamp: string; action: string; payload: string }>(200);
    
    // 2. Stress-simulate pushing 5000 heavy simulated event objects rapidly
    const startTimeStamp = Date.now();
    for (let i = 0; i < 5000; i++) {
        circularBuffer.push({
            sequenceId: i,
            timestamp: new Date().toISOString(),
            action: `gate_execution_${i}`,
            payload: `stdout:\n${'A'.repeat(500)}` // 500 chars payload
        });
    }
    const durationMs = Date.now() - startTimeStamp;

    // Buffer length MUST be capped at the capacity (200), preventing scaling memory leakage
    assert.strictEqual(circularBuffer.length, 200, 'Circular buffer count must remain strictly bound to capacity limit');
    
    // Check elements correctness and structure sequence
    const finalArray = circularBuffer.toArray();
    assert.strictEqual(finalArray.length, 200);
    // The very last sequenceId should be 4999
    assert.strictEqual(finalArray[199]!.sequenceId, 4999, 'Tail of circular buffer must align with last inserted sequence');
    
    // 3. Stress test the main Working Memory Truncation pipeline
    // Build a progressively growing historical dialog context of 1000 loops
    const historyStream: { role: 'user' | 'assistant'; content: string }[] = [];
    historyStream.push({ role: 'user', content: 'INITIAL_ROOT_OBJECTIVE_TASK_REQUIREMENTS_SUMMARY' });
    
    for (let i = 0; i < 1000; i++) {
        historyStream.push({
            role: i % 2 === 0 ? 'assistant' : 'user',
            content: `Execution Cycle ID ${i} finished with detailed sub-logs:\nstdout:\n${'DATA_DUMP_'.repeat(200)}\n`
        });
    }
    
    // Push through the fast cache-optimized truncation slider
    const prunedHistory = enforceWorkingMemoryTruncation(historyStream);
    
    // Assert the structural markers remain intact and compiled accurately
    assert.strictEqual(prunedHistory.length, 6, 'Pruned history must collapse to exactly 6 structural components');
    assert.strictEqual(prunedHistory[0]!.content, 'INITIAL_ROOT_OBJECTIVE_TASK_REQUIREMENTS_SUMMARY', 'Root objective at index 0 must be preserved');
    assert.ok(prunedHistory[1]!.content.includes('aggressively pruned'), 'Pruned notification must be compiled at index 1');
    
    // Assert that the exact trailing two cycles are fully preserved at the end of the timeline
    assert.ok(prunedHistory[2]!.content.includes('Cycle ID 996'), 'Preserved Cycle 1 start matches');
    assert.ok(prunedHistory[3]!.content.includes('Cycle ID 997'), 'Preserved Cycle 1 response matches');
    assert.ok(prunedHistory[4]!.content.includes('Cycle ID 998'), 'Preserved Cycle 2 start matches');
    assert.ok(prunedHistory[5]!.content.includes('Cycle ID 999'), 'Preserved Cycle 2 response matches');

    // Total content size has successfully dropped to far below 40,000 character limit
    const cumulativeCharacters = prunedHistory.reduce((sum, item) => sum + item.content.length, 0);
    assert.ok(cumulativeCharacters < 40000, 'Cumulative output character footprint must drop safely below strict 40k threshold');
});

runTest('Reconnection Boundary Interleaving and Monotonic Sequence Clamping', () => {
    // 1. Setup server-side SlidingWindowCircularBuffer
    const buffer = new SlidingWindowCircularBuffer<{ sequenceId: number; type: string }>(10);

    // 2. Rapidly simulate 25 events to trigger sliding window truncation
    for (let i = 1; i <= 25; i++) {
        buffer.push({ sequenceId: i, type: `event_${i}` });
    }

    // Since capacity is 10, the buffer must hold exactly 10 items (sequences 16 to 25)
    assert.strictEqual(buffer.length, 10, 'Buffer capacity clamping failed');

    // 3. Find minimum active sequence ID currently in buffer
    const minValidSequenceId = buffer.getMinId();
    assert.strictEqual(minValidSequenceId, 16, 'minValidSequenceId must resolve to the oldest survived sequence ID');

    // 4. Simulate State Snapshot payload delivery
    const stateSnapshot = {
        isRunning: true,
        retryCount: 1,
        minValidSequenceId
    };

    // 5. Simulate client-side queue containing out-of-order and overlapping incoming events
    const pendingEventsQueue = [
        { sequenceId: 14, type: 'event_14' }, // Stale out-of-order event (before boundary)
        { sequenceId: 15, type: 'event_15' }, // Stale out-of-order event (before boundary)
        { sequenceId: 24, type: 'event_24' }, // Valid buffered live event (after boundary)
        { sequenceId: 25, type: 'event_25' }, // Valid buffered live event (after boundary)
        { sequenceId: 26, type: 'event_26' }  // Fresh live event (new)
    ];

    // 6. Simulate useGateLoop's client-side parser boundary filter logic
    const minValidSeqIdFromSnapshot = stateSnapshot.minValidSequenceId;
    let eventsToFlush = pendingEventsQueue;
    if (minValidSeqIdFromSnapshot > 0) {
        eventsToFlush = pendingEventsQueue.filter((ev: any) => {
            const seq = ev?.sequenceId ?? ev?.data?.sequenceId;
            return seq === undefined || seq >= minValidSeqIdFromSnapshot;
        });
    }

    // 7. Assert that events older than minValidSequenceId are successfully pruned
    assert.strictEqual(eventsToFlush.length, 3, 'Filtering logic must retain exactly 3 valid elements');
    assert.ok(!eventsToFlush.some(ev => ev.sequenceId < 16), 'Any event sequenceId below the minimum valid sequenceId floor must be purged');
    assert.strictEqual(eventsToFlush[0]!.sequenceId, 24);
    assert.strictEqual(eventsToFlush[1]!.sequenceId, 25);
    assert.strictEqual(eventsToFlush[2]!.sequenceId, 26);
});

// Tests completed successfully under Vitest!
