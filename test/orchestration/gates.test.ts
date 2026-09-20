import { describe, it } from 'vitest';
import assert from 'node:assert';
import { parseEvent } from '../../src/ui/parser';
import { CopilotEvent } from '../../src/ui/mockEvents';

describe('Gate Parser & Lifecycle Regression Tests', () => {
  it('Test Case 1: Gate Start Event Parsing', () => {
    const gateStartEvt: CopilotEvent = {
      title: 'Testing Gate Start',
      category: 'system',
      sessionEvent: {
        id: 'evt-1',
        timestamp: Date.now(),
        type: 'gate.start',
        data: { gateName: 'runTests' }
      } as any
    };

    const parsedStart = parseEvent(gateStartEvt);
    assert(parsedStart.pToolName === 'runTests', 'Gate name should be captured in pToolName');
    assert(parsedStart.pSummary.includes('Initiated Gate Check'), 'Summary should reflect initiation');
  });

  it('Test Case 2: Gate Result Event Passing', () => {
    const gatePassEvt: CopilotEvent = {
      title: 'Testing Gate Pass',
      category: 'system',
      sessionEvent: {
        id: 'evt-2',
        timestamp: Date.now(),
        type: 'gate.result',
        data: { 
          gateName: 'runLint', 
          pass: true, 
          durationMs: 450, 
          feedback: 'No lint errors found' 
        }
      } as any
    };

    const parsedPass = parseEvent(gatePassEvt);
    assert(parsedPass.pResultType === 'success', 'Result type should be success');
    assert(parsedPass.pExecutionMs === 450, 'Duration should be captured correctly');
    assert(parsedPass.pText === 'No lint errors found', 'Feedback should be captured in pText');
  });

  it('Test Case 3: Gate Result Event Failure', () => {
    const gateFailEvt: CopilotEvent = {
      title: 'Testing Gate Fail',
      category: 'system',
      sessionEvent: {
        id: 'evt-3',
        timestamp: Date.now(),
        type: 'gate.result',
        data: { 
          gateName: 'runTests', 
          pass: false, 
          durationMs: 200, 
          feedback: '1 test failed: division by zero' 
        }
      } as any
    };

    const parsedFail = parseEvent(gateFailEvt);
    assert(parsedFail.pResultType === 'failure', 'Result type should be failure');
    assert(parsedFail.pText.includes('division by zero'), 'Failure feedback should be resolved');
  });

  it('Test Case 4: Loop Complete Event', () => {
    const loopCompleteEvt: CopilotEvent = {
      title: 'Testing Loop Complete',
      category: 'system',
      sessionEvent: {
        id: 'evt-4',
        timestamp: Date.now(),
        type: 'loop.complete',
        data: { 
          totalRetries: 1, 
          gatesRun: ['runLint', 'runTests'],
          durationMs: 3500
        }
      } as any
    };

    const parsedComplete = parseEvent(loopCompleteEvt);
    assert(parsedComplete.pSummary.includes('finished successfully'), 'Summary should reflect success');
    assert(parsedComplete.pDetails.includes('Retries: 1'), 'Details should include retry count');
    assert(parsedComplete.pExecutionMs === 3500, 'Total loop duration should be captured');
  });

  it('Test Case 5: History-Aware Prompt Generation', async () => {
    const { formatContextNarrowingPrompt } = await import('../../src/orchestration/prompt');
    const mockHistory: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: 'Fix the bug in main.ts' },
      { role: 'assistant', content: 'I have updated the division logic.' }
    ];
    const promptWithHistory = formatContextNarrowingPrompt('Original Request', 'lint', 'Feedback info', mockHistory);
    assert(promptWithHistory.includes('[Conversation History]'), 'Prompt should contain history header');
    assert(promptWithHistory.includes('assistant: I have updated the division logic.'), 'Prompt should contain assistant message from history');
  });

  it('Test Case 6: Dynamic Blueprint Generation (T3)', async () => {
    const { resolvePipeline } = await import('../../src/config/gates');
    
    const refactorPipeline = resolvePipeline('refactor');
    assert(refactorPipeline.includes('runLint') && refactorPipeline.includes('runTests'), 'Refactor blueprint should include lint and tests');
    
    const featurePipeline = resolvePipeline('feature');
    assert(featurePipeline.length === 3, 'Feature blueprint should have exactly 3 gates');
    assert(featurePipeline.includes('runAudit'), 'Feature blueprint should include runAudit');
    
    const unknownPipeline = resolvePipeline('unknown-type');
    assert(Array.isArray(unknownPipeline) && unknownPipeline.length === 0, 'Unknown blueprint should resolve to empty array');
  });
});
