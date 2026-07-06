import { ModelTier } from '../config/models';
import { CopilotSession } from '../copilotSdk/boundary';

export interface TaskDecomposition {
  readonly version: number;
  readonly timestamp: string;
  readonly steps: ReadonlyArray<string>;
  readonly rationale: string;
}

export interface StateSnapshot {
  readonly isRunning: boolean;
  readonly retryCount: number;
  readonly currentTier: ModelTier;
  readonly activeGate: string | undefined;
  readonly hasFailureState: boolean;
  readonly awaitingHuman: boolean;
  readonly manualIntervention?: boolean;
  readonly minValidSequenceId?: number;
  readonly currentPrompt?: string;
  readonly retryHistory?: ReadonlyArray<unknown>;
  readonly failedGateName?: string;
  readonly failedGateFeedback?: string;
  readonly totalRetries?: number;
  readonly currentModelIndex?: number;
}

export interface CopilotEventPayload {
  readonly sequenceId?: number;
  readonly stateSnapshot?: StateSnapshot;
  readonly [key: string]: unknown;
}

export interface CopilotEventData {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly sequenceId?: number;
  readonly data?: CopilotEventPayload;
}

export function getSequenceId(ev: CopilotEventData): number {
  if (typeof ev.sequenceId === 'number') {
    return ev.sequenceId;
  }
  if (ev.data && typeof ev.data === 'object') {
    const data = ev.data as CopilotEventPayload;
    if (typeof data.sequenceId === 'number') {
      return data.sequenceId;
    }
  }
  return 0;
}

export interface Turn {
  readonly id: string;
  readonly taskLabel: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly events: ReadonlyArray<CopilotEventData>;
  readonly commitSha?: string | undefined;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly copilotSession: CopilotSession;
  readonly currentModel: ModelTier;
  readonly cwd: string;
  readonly lastUsedAt: number;

  // Task 1: Added for tracking execution history
  readonly currentTierIndex?: number;
  readonly planVersions?: ReadonlyArray<TaskDecomposition>;
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly eventSequenceCounter?: number;
  readonly stateSnapshot: StateSnapshot;
  readonly conversationHistory: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
  readonly turns: ReadonlyArray<Turn>;
  readonly diagnosticTrail?: ReadonlyArray<unknown>;
  readonly unsubscribe?: () => void;
  readonly pendingPatchedSpec?: string;
  readonly lastPassedSpecAuditSha?: string;
}
