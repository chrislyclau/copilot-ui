import { SessionEvent } from '@github/copilot-sdk';

/**
 * Custom gate and loop events used for the verification cycles.
 */

export interface GateStartData {
  readonly gateName: string;
}

export interface GateResultData {
  readonly gateName: string;
  readonly pass: boolean;
  readonly feedback: string;
  readonly durationMs: number;
}

export interface LoopRetryData {
  readonly retryCount: number;
  readonly feedback: string;
  readonly nextModel: string;
}

export interface LoopCompleteData {
  readonly totalRetries: number;
  readonly gatesRun: ReadonlyArray<string>;
  readonly durationMs: number;
}

export interface LoopEscalateHumanData {
  readonly summary: string;
}

export interface LoopClarityCheckFailedData {
  readonly score: number;
  readonly missingVariables: ReadonlyArray<string>;
  readonly feedback: string;
}

export interface LoopClarityCheckFailedEvent {
  type: 'loop.clarity_check_failed';
  data: LoopClarityCheckFailedData;
}

export interface ToolResultData {
  readonly toolName: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ComposerPlanData {
  readonly taskType: string;
  readonly resolvedGates: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<string>;
  readonly targetDirectories: ReadonlyArray<string>;
}

export interface ComposerPlanMutatedData {
  readonly cycle: number;
  readonly newGates: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<string>;
}

export interface ComposerPlanEvent {
  readonly type: 'composer.plan';
  readonly data: ComposerPlanData;
}

export interface ComposerPlanMutatedEvent {
  readonly type: 'composer.plan_mutated';
  readonly data: ComposerPlanMutatedData;
}

export interface TurnCompletedData {
  readonly turnId: string;
  readonly taskLabel: string;
  readonly commitSha: string;
}

export interface TurnCompletedEvent {
  readonly type: 'TURN_COMPLETED';
  readonly data: TurnCompletedData;
}

/**
 * Union of all custom event types.
 */
export type CustomEventData =
  | { readonly type: 'gate.start'; readonly data: GateStartData }
  | { readonly type: 'gate.result'; readonly data: GateResultData }
  | { readonly type: 'loop.retry'; readonly data: LoopRetryData }
  | { readonly type: 'loop.complete'; readonly data: LoopCompleteData }
  | { readonly type: 'loop.error'; readonly data: { readonly message: string; readonly stateSnapshot?: unknown } }
  | { readonly type: 'loop.escalate_human'; readonly data: LoopEscalateHumanData }
  | LoopClarityCheckFailedEvent
  | { readonly type: 'tool.result'; readonly data: ToolResultData }
  | ComposerPlanEvent
  | ComposerPlanMutatedEvent
  | { readonly type: 'gate.legacyAudit'; readonly data: unknown }
  | TurnCompletedEvent;

/**
 * Extended SessionEvent that including our custom cycle events.
 */
export type ExtendedSessionEvent = SessionEvent | (Omit<SessionEvent, 'type' | 'data'> & CustomEventData);
