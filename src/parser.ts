import { CopilotEvent } from './mockEvents';
import {
  AssistantMessageDeltaEvent,
  AssistantReasoningDeltaEvent,
  AssistantStreamingDeltaEvent
} from '@github/copilot-sdk';
import { ExtendedSessionEvent } from './types/events';
import { assertNever } from './types';

/**
 * Smartly extracts readable user-facing content/text from an assistant response event payload.
 */
export function extractAssistantText(
  sessionEvent: ExtendedSessionEvent | unknown
): string {
  if (typeof sessionEvent === 'string') return sessionEvent;
  if (!sessionEvent || typeof sessionEvent !== 'object') return '';
  
  const event = sessionEvent as any; // Still need this for now because of the loose structure
  if (event.type === 'assistant.message_delta' || event.type === 'assistant.reasoning_delta') {
    return event.data?.deltaContent || '';
  }

  // Handle unit tests mock structure and various wrappers
  if (event.choices?.[0]?.message?.content) {
    return event.choices[0].message.content;
  }
  if (event.choices?.[0]?.delta?.content) {
    return event.choices[0].delta.content;
  }
  if (event.candidates?.[0]?.content?.parts?.[0]?.text) {
    return event.candidates[0].content.parts[0].text;
  }
  if (event.message?.content) {
    return event.message.content;
  }
  if (event.content?.text) {
    return event.content.text;
  }
  if (event.content && typeof event.content === 'string') {
    return event.content;
  }
  if (event.text && typeof event.text === 'string') {
    return event.text;
  }
  if (event.data && typeof event.data === 'object') {
    const data = event.data;
    if (data.deltaContent) return String(data.deltaContent);
    if (data.content && typeof data.content === 'string') return data.content;
    if (data.result?.content) return String(data.result.content);
  }
  return '';
}

/**
 * Checks if an event is an assistant delta or streaming delta event.
 */
export const isDeltaEvent = (evt: CopilotEvent): evt is CopilotEvent & {
  sessionEvent: AssistantMessageDeltaEvent | AssistantReasoningDeltaEvent | AssistantStreamingDeltaEvent;
} => {
  if (!evt || !evt.sessionEvent || !evt.sessionEvent.type) return false;

  // Ensure delta event has valid data payload if provided
  if ((evt.sessionEvent as any).data === null) return false;

  const t = evt.sessionEvent.type.toLowerCase();
  return (
    t === 'assistant.message_delta' ||
    t === 'assistant.reasoning_delta' ||
    t === 'assistant.streaming_delta' ||
    t.includes('delta')
  );
};

export interface ParsedEventPayload {
  pText: string;
  pPrompt: string;
  pAttachments: unknown[];
  pSessionId: string;
  pWorkingDirectory: string;
  pClientName: string;
  pModel: string;
  pClientMode: string;
  pSysSections: number;
  pToolCallId: string;
  pToolName: string;
  pArguments: unknown;
  pResultType: string;
  pExecutionMs: number | string;
  pError: string;
  pTextResult: string;
  pBinaryResults: unknown[];
  pThought: string;
  pEffort: string;
  pFileName: string;
  pKind: string;
  pDiff: string;
  pDecision: string;
  pComments: string;
  pDetails: string;
  pReason: string;
  pSummary: string;
}

export { deriveEventMeta } from './utils/deriveEventMeta';

/**
 * Extracts, flattens, and normalizes all potential fields from a variety of
 * session event formats using canonical @github/copilot-sdk types and type-safe narrowing.
 */
export const parseEvent = (event: CopilotEvent): ParsedEventPayload => {
  const sessionEvent = event.sessionEvent;

  let pText = '';
  let pPrompt = '';
  let pAttachments: unknown[] = [];
  let pSessionId = '';
  let pWorkingDirectory = '';
  let pClientName = '';
  let pModel = '';
  let pClientMode = '';
  let pSysSections = 4;
  let pToolCallId = '';
  let pToolName = '';
  let pArguments: unknown = {};
  let pResultType = 'success';
  let pExecutionMs: number | string = '';
  let pError = '';
  let pTextResult = '';
  let pBinaryResults: unknown[] = [];
  let pThought = '';
  let pEffort = 'medium';
  let pFileName = '';
  let pKind = '';
  let pDiff = '';
  let pDecision = '';
  let pComments = '';
  let pDetails = '';
  let pReason = '';
  let pSummary = '';

  if (event.isBundle) {
    pText = sessionEvent.type === 'assistant.message'
      ? (sessionEvent as any).data?.content || ''
      : '';
  } else {
    // Discriminated union handling for custom and standard events
    const type = sessionEvent.type;
    const data = sessionEvent.data as any; // Temporary fallback for SDK types that are complex

    switch (type) {
      case 'session.start':
        pSessionId = data.sessionId;
        pWorkingDirectory = data.context?.cwd ?? '';
        pClientName = `${data.producer} (v${data.copilotVersion})`;
        pModel = data.selectedModel ?? '';
        pEffort = data.reasoningEffort ?? 'medium';
        break;

      case 'user.message':
        pPrompt = data.content;
        pAttachments = data.attachments ?? [];
        break;

      case 'assistant.reasoning':
        pThought = data.content;
        pText = data.content;
        break;

      case 'tool.execution_start':
        pToolCallId = data.toolCallId;
        pToolName = data.toolName;
        pArguments = data.arguments ?? {};
        pModel = data.model ?? '';
        break;

      case 'tool.execution_complete':
        pToolCallId = data.toolCallId;
        pToolName = data.toolDescription?.name || data.toolName || '';
        pResultType = data.success ? 'success' : 'failure';
        pError = data.error?.message ?? '';
        if (data.result && typeof data.result === 'object') {
          const result = data.result;
          if ('content' in result && typeof result.content === 'string') {
            pTextResult = result.content;
          }
          if (Array.isArray(result.contents)) {
            try {
              pBinaryResults = result.contents.filter((c: any) => {
                return c && typeof c === 'object' && 'type' in c && c.type !== 'text';
              });
            } catch (e) {
              console.error('Failed to parse binary results:', e);
              pBinaryResults = [];
            }
          }
        }
        pText = pTextResult;
        pModel = data.model ?? '';
        if (data.toolTelemetry?.executionTimeMs !== undefined) {
          pExecutionMs = String(data.toolTelemetry.executionTimeMs);
        }
        break;

      case 'permission.requested': {
        const req = data.permissionRequest;
        pKind = req.kind;
        if ('intention' in req && typeof req.intention === 'string') {
          pReason = req.intention;
        }
        if (req.kind === 'write') {
          pFileName = req.fileName;
          pDiff = req.diff;
        } else if (req.kind === 'shell') {
          pPrompt = req.fullCommandText;
        }
        break;
      }

      case 'permission.completed':
        pDecision = data.result?.kind ?? '';
        break;

      case 'session.error':
        pError = data.message;
        pDetails = data.stack ?? '';
        break;

      case 'assistant.message':
        pText = data.content;
        break;

      case 'session.shutdown':
        pSummary = 'Session ended';
        break;

      case 'gate.start':
        pToolName = data.gateName;
        pSummary = `Initiated Gate Check: ${data.gateName}`;
        break;

      case 'gate.result':
        pToolName = data.gateName;
        pResultType = data.pass ? 'success' : 'failure';
        pText = data.feedback;
        pExecutionMs = data.durationMs;
        break;
      
      case 'composer.plan':
        pSummary = `Dynamic Routing Complete: ${data.taskType}`;
        pDetails = `Resolved Gates: ${(data.gates || data.resolvedGates || []).join(', ') || 'None'}`;
        pText = data.taskType;
        break;

      case 'composer.plan_mutated':
        pSummary = `Dynamic Blueprint Mutated (Healed)`;
        pDetails = `New Gates: ${(data.gates || data.newGates || []).join(', ') || 'None'}`;
        pText = `Cycle: ${data.cycle}`;
        break;

      case 'loop.retry':
        pSummary = `Retrying cycle (attempt ${data.retryCount})`;
        pDetails = data.feedback;
        pModel = data.nextModel;
        break;

      case 'loop.complete':
        if (data.reason === 'CEILING_BREACHED') {
          pSummary = `Execution stopped: Iteration ceiling reached (${data.maxCycles} max).`;
          pResultType = 'failure';
          pError = data.feedback;
        } else {
          pSummary = `Verification cycle finished successfully.`;
          pResultType = 'success';
        }
        pDetails = `Retries: ${data.totalRetries ?? 0}, Gates: ${data.gatesRun?.join(', ') ?? 'N/A'}`;
        pExecutionMs = data.durationMs;
        break;

      case 'loop.escalate_human':
        pSummary = 'Halted for Human Review';
        pError = data.summary;
        break;

      case 'loop.clarity_check_failed':
        pSummary = 'Goal Ambiguity Detected';
        pResultType = 'failure';
        pError = data.feedback;
        pDetails = `Clarity Score: ${data.score}`;
        break;

      case 'tool.result':
        pToolName = data.toolName;
        pTextResult = data.stdout || data.stderr || '';
        pResultType = data.exitCode === 0 ? 'success' : 'failure';
        pText = pTextResult;
        break;
      
      case 'TURN_COMPLETED':
        pSummary = `Milestone: ${data.taskLabel}`;
        pDetails = `Commit SHA: ${data.commitSha || 'Pending'}`;
        break;

      case 'gate.legacyAudit':
        pToolName = data.action;
        pText = data.rationale;
        pModel = data.tier;
        break;
      default:
        // Do nothing for unhandled event types
        break;
    }
  }

  return {
    pText,
    pPrompt,
    pAttachments,
    pSessionId,
    pWorkingDirectory,
    pClientName,
    pModel,
    pClientMode,
    pSysSections,
    pToolCallId,
    pToolName,
    pArguments,
    pResultType,
    pExecutionMs,
    pError,
    pTextResult,
    pBinaryResults,
    pThought,
    pEffort,
    pFileName,
    pKind,
    pDiff,
    pDecision,
    pComments,
    pDetails,
    pReason,
    pSummary,
  };
};

/**
 * Bundles consecutive assistant delta/streaming delta events into a unified assistant.message event.
 */
export const getBundledEvents = (events: CopilotEvent[]): CopilotEvent[] => {
  if (!events || events.length === 0) return [];
  const result: CopilotEvent[] = [];
  let currentBundle: CopilotEvent[] = [];

  const flushBundle = () => {
    if (currentBundle.length === 0) return;

    const firstEvt = currentBundle[0]!;

    // Concatenate text
    let assembledText = '';
    currentBundle.forEach(evt => {
      assembledText += extractAssistantText(evt.sessionEvent);
    });

    // Sum telemetry
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let totalNanoAiu = 0;
    let creditsCost = 0;
    let hasTelemetry = false;

    currentBundle.forEach(evt => {
      if (evt.telemetryUsage) {
        hasTelemetry = true;
        promptTokens += evt.telemetryUsage.promptTokens || 0;
        completionTokens += evt.telemetryUsage.completionTokens || 0;
        reasoningTokens += evt.telemetryUsage.reasoningTokens || 0;
        totalNanoAiu += evt.telemetryUsage.totalNanoAiu || 0;
        creditsCost += evt.telemetryUsage.creditsCost || 0;
      }
    });

    const bundledEvent: CopilotEvent = {
      title: `Assistant Stream (${currentBundle.length} consecutive events)`,
      category: 'assistant',
      isBundle: true,
      bundleType: firstEvt.sessionEvent.type,
      originalEvents: [...currentBundle],
      sessionEvent: {
        id: `bundle-${firstEvt.sessionEvent.id}`,
        parentId: firstEvt.sessionEvent.parentId,
        timestamp: firstEvt.sessionEvent.timestamp,
        type: 'assistant.message',
        data: {
          content: assembledText
        }
      } as ExtendedSessionEvent,
      ...(hasTelemetry ? {
        telemetryUsage: {
          promptTokens: promptTokens || undefined,
          completionTokens: completionTokens || undefined,
          reasoningTokens: reasoningTokens || undefined,
          totalNanoAiu,
          creditsCost: parseFloat(creditsCost.toFixed(6))
        }
      } : {})
    };

    result.push(bundledEvent);
    currentBundle = [];
  };

  events.forEach(evt => {
    if (isDeltaEvent(evt)) {
      currentBundle.push(evt);
    } else {
      flushBundle();
      result.push(evt);
    }
  });

  flushBundle();
  return result;
};
