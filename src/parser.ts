import { CopilotEvent } from './mockEvents';
import {
  AssistantMessageDeltaEvent,
  AssistantReasoningDeltaEvent,
  AssistantStreamingDeltaEvent
} from './copilotSdk/boundary';
import { ExtendedSessionEvent } from './types/events';

/**
 * Smartly extracts readable user-facing content/text from an assistant response event payload.
 */
export function extractAssistantText(
  sessionEvent: ExtendedSessionEvent | unknown
): string {
  if (typeof sessionEvent === 'string') return sessionEvent;
  if (!sessionEvent || typeof sessionEvent !== 'object') return '';

  const event = sessionEvent as Record<string, unknown>;
  const eventType = event.type as string | undefined;
  if (eventType === 'assistant.message_delta' || eventType === 'assistant.reasoning_delta') {
    const data = event.data as Record<string, unknown> | undefined;
    return (data?.deltaContent as string | undefined) || '';
  }
  // Handle unit tests mock structure and various wrappers
  const choices = event.choices as readonly unknown[] | undefined;
  if (choices?.[0] && typeof choices[0] === 'object') {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice.message as Record<string, unknown> | undefined;
    if (message?.content) {
      return String(message.content);
    }
  }
  if (choices?.[0] && typeof choices[0] === 'object') {
    const firstChoice = choices[0] as Record<string, unknown>;
    const delta = firstChoice.delta as Record<string, unknown> | undefined;
    if (delta?.content) {
      return String(delta.content);
    }
  }
  const candidates = event.candidates as readonly unknown[] | undefined;
  if (candidates?.[0] && typeof candidates[0] === 'object') {
    const firstCandidate = candidates[0] as Record<string, unknown>;
    const content = firstCandidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts as readonly unknown[] | undefined;
    if (parts?.[0] && typeof parts[0] === 'object') {
      const firstPart = parts[0] as Record<string, unknown>;
      if (firstPart.text) {
        return String(firstPart.text);
      }
    }
  }
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.content) {
    return String(message.content);
  }
  const content = event.content as Record<string, unknown> | string | undefined;
  if (content && typeof content === 'object') {
    if (content.text) {
      return String(content.text);
    }
  } else if (content && typeof content === 'string') {
    return content;
  }
  if (event.text && typeof event.text === 'string') {
    return event.text;
  }
  if (event.data && typeof event.data === 'object') {
    const data = event.data as Record<string, unknown>;
    if (data.deltaContent) return String(data.deltaContent);
    if (data.content && typeof data.content === 'string') return data.content;
    const result = data.result as Record<string, unknown> | undefined;
    if (result?.content) return String(result.content);
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
  const se = evt.sessionEvent as Record<string, unknown>;
  if (se.data === null) return false;
  const t = evt.sessionEvent.type.toLowerCase();
  return (
    t === 'assistant.message_delta' ||
    t === 'assistant.reasoning_delta' ||
    t === 'assistant.streaming_delta' ||
    t.includes('delta')
  );
};

export interface ParsedEventPayload {
  readonly pText: string;
  readonly pPrompt: string;
  readonly pAttachments: readonly unknown[];
  readonly pSessionId: string;
  readonly pWorkingDirectory: string;
  readonly pClientName: string;
  readonly pModel: string;
  readonly pClientMode: string;
  readonly pSysSections: number;
  readonly pToolCallId: string;
  readonly pToolName: string;
  readonly pArguments: unknown;
  readonly pResultType: string;
  readonly pExecutionMs: number | string;
  readonly pError: string;
  readonly pTextResult: string;
  readonly pBinaryResults: readonly unknown[];
  readonly pThought: string;
  readonly pEffort: string;
  readonly pFileName: string;
  readonly pKind: string;
  readonly pDiff: string;
  readonly pDecision: string;
  readonly pComments: string;
  readonly pDetails: string;
  readonly pReason: string;
  readonly pSummary: string;
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
  let pAttachments: readonly unknown[] = [];
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
  let pBinaryResults: readonly unknown[] = [];
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
    const se = sessionEvent as Record<string, unknown>;
    const seData = se.data as Record<string, unknown> | undefined;
    pText = sessionEvent.type === 'assistant.message'
      ? (seData?.content as string | undefined) || ''
      : '';
  } else {
    // Discriminated union handling for custom and standard events
    const type = sessionEvent.type;
    const data = (sessionEvent.data && typeof sessionEvent.data === 'object' 
      ? sessionEvent.data as Record<string, unknown> 
      : {}) as Record<string, unknown>;
    switch (type) {
      case 'session.start':
        pSessionId = data.sessionId as string;
        pWorkingDirectory = (data.context as Record<string, unknown> | undefined)?.cwd as string ?? '';
        pClientName = `${data.producer} (v${data.copilotVersion})`;
        pModel = data.selectedModel as string ?? '';
        pEffort = data.reasoningEffort as string ?? 'medium';
        break;
      case 'user.message':
        pPrompt = data.content as string;
        pAttachments = (data.attachments as unknown[]) ?? [];
        break;
      case 'assistant.reasoning':
        pThought = data.content as string;
        pText = data.content as string;
        break;
      case 'tool.execution_start':
        pToolCallId = data.toolCallId as string;
        pToolName = data.toolName as string;
        pArguments = data.arguments ?? {};
        pModel = data.model as string ?? '';
        break;
      case 'tool.execution_complete': {
        pToolCallId = data.toolCallId as string;
        const toolDescription = data.toolDescription as Record<string, unknown> | undefined;
        pToolName = toolDescription?.name as string || data.toolName as string || '';
        pResultType = data.success ? 'success' : 'failure';
        const errorVal = data.error as Record<string, unknown> | undefined;
        pError = errorVal?.message as string ?? '';
        if (data.result && typeof data.result === 'object') {
          const result = data.result as Record<string, unknown>;
          if ('content' in result && typeof result.content === 'string') {
            pTextResult = result.content;
          }
          const contents = result.contents as readonly unknown[] | undefined;
          if (Array.isArray(contents)) {
            try {
              pBinaryResults = contents.filter((c: unknown) => {
                return c && typeof c === 'object' && 'type' in c && (c as Record<string, unknown>).type !== 'text';
              });
            } catch (e) {
              console.error('Failed to parse binary results:', e);
              pBinaryResults = [];
            }
          }
        }
        pText = pTextResult;
        pModel = data.model as string ?? '';
        const toolTelemetry = data.toolTelemetry as Record<string, unknown> | undefined;
        if (toolTelemetry?.executionTimeMs !== undefined) {
          pExecutionMs = String(toolTelemetry.executionTimeMs);
        }
        break;
      }
      case 'permission.requested': {
        const req = data.permissionRequest as Record<string, unknown>;
        pKind = req.kind as string;
        if (req && 'intention' in req && typeof req.intention === 'string') {
          pReason = req.intention;
        }
        if (req.kind === 'write') {
          pFileName = req.fileName as string;
          pDiff = req.diff as string;
        } else if (req.kind === 'shell') {
          pPrompt = req.fullCommandText as string;
        }
        break;
      }
      case 'permission.completed': {
        const resultVal = data.result as Record<string, unknown> | undefined;
        pDecision = resultVal?.kind as string ?? '';
        break;
      }
      case 'session.error':
        pError = data.message as string;
        pDetails = data.stack as string ?? '';
        break;
      case 'assistant.message':
        pText = data.content as string;
        break;
      case 'session.shutdown':
        pSummary = 'Session ended';
        break;
      case 'gate.start':
        pToolName = data.gateName as string;
        pSummary = `Initiated Gate Check: ${data.gateName}`;
        break;
      case 'gate.result':
        pToolName = data.gateName as string;
        pResultType = data.pass ? 'success' : 'failure';
        pText = data.feedback as string;
        pExecutionMs = data.durationMs as number | string;
        break;
      case 'composer.plan': {
        pSummary = `Dynamic Routing Complete: ${data.taskType}`;
        const gates = (data.gates || data.resolvedGates || []) as readonly string[];
        pDetails = `Resolved Gates: ${gates.join(', ') || 'None'}`;
        pText = data.taskType as string;
        break;
      }
      case 'composer.plan_mutated': {
        pSummary = `Dynamic Blueprint Mutated (Healed)`;
        const gates = (data.gates || data.newGates || []) as readonly string[];
        pDetails = `New Gates: ${gates.join(', ') || 'None'}`;
        pText = `Cycle: ${data.cycle}`;
        break;
      }
      case 'loop.retry':
        pSummary = `Retrying cycle (attempt ${data.retryCount})`;
        pDetails = data.feedback as string;
        pModel = data.nextModel as string;
        break;
      case 'loop.complete':
        if (data.reason === 'CEILING_BREACHED') {
          pSummary = `Execution stopped: Iteration ceiling reached (${data.maxCycles} max).`;
          pResultType = 'failure';
          pError = data.feedback as string;
        } else {
          pSummary = `Verification cycle finished successfully.`;
          pResultType = 'success';
        }
        pDetails = `Retries: ${data.totalRetries ?? 0}, Gates: ${((data.gatesRun || []) as readonly string[]).join(', ') ?? 'N/A'}`;
        pExecutionMs = data.durationMs as number | string;
        break;
      case 'loop.escalate_human':
        pSummary = 'Halted for Human Review';
        pError = data.summary as string;
        break;
      case 'loop.clarity_check_failed':
        pSummary = 'Goal Ambiguity Detected';
        pResultType = 'failure';
        pError = data.feedback as string;
        pDetails = `Clarity Score: ${data.score}`;
        break;
      case 'tool.result':
        pToolName = data.toolName as string;
        pTextResult = (data.stdout as string | undefined) || (data.stderr as string | undefined) || '';
        pResultType = data.exitCode === 0 ? 'success' : 'failure';
        pText = pTextResult;
        break;
      case 'TURN_COMPLETED':
        pSummary = `Milestone: ${data.taskLabel}`;
        pDetails = `Commit SHA: ${data.commitSha || 'Pending'}`;
        break;
      case 'gate.legacyAudit':
        pToolName = data.action as string;
        pText = data.rationale as string;
        pModel = data.tier as string;
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
    pBinaryResults: [...pBinaryResults],
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
export const getBundledEvents = (
  events: readonly CopilotEvent[]
): readonly CopilotEvent[] => {
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
