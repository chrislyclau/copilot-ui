import { CopilotEvent, TurnData } from './mockEvents';

export interface RunGateLoopRequest {
  readonly prompt: string;
  readonly gates: ReadonlyArray<'tests' | 'lint' | 'audit'>;
  readonly maxRetries: number;
  readonly sessionId: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly cwd: string;
  readonly diagnosticScenario?: string;
  readonly replayTraceId?: string;
  readonly simulateBackpressureDelayMs?: number;
}

export interface GateConfig extends RunGateLoopRequest {
  readonly setScenarioTurns?: (scenarioId: string, turns: readonly TurnData[], events: ReadonlyArray<CopilotEvent>) => void;
}

declare global {
  interface Window {
    __addScenario?: (scenario: unknown) => void;
  }
}

export type BooleanMap = ReadonlyArray<{ readonly key: string; readonly value: boolean }>;

export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${x}`);
}

export interface TimelineHandlers {
  readonly setExpandedActionHistories: (props: { readonly value: React.SetStateAction<BooleanMap> }) => void;
  readonly setExpandedCollapsedGroups: (props: { readonly value: React.SetStateAction<BooleanMap> }) => void;
  readonly setFocusedEventId: (props: { readonly id: string | undefined }) => void;
  readonly setTab: (props: { readonly id: string; readonly tab: 'details' | 'json' | 'stream' }) => void;
  readonly copyToClipboard: (props: { readonly text: string; readonly label: string }) => void;
  readonly toggleExpandCard: (props: { readonly id: string; readonly e?: React.MouseEvent }) => void;
}

export interface TimelineHookReturn {
  readonly expandedEvents: BooleanMap;
  readonly setExpandedEvents: React.Dispatch<React.SetStateAction<BooleanMap>>;
  readonly expandedActionHistories: BooleanMap;
  readonly setExpandedActionHistories: React.Dispatch<React.SetStateAction<BooleanMap>>;
  readonly expandedCollapsedGroups: BooleanMap;
  readonly setExpandedCollapsedGroups: React.Dispatch<React.SetStateAction<BooleanMap>>;
  readonly expandedTurns: BooleanMap;
  readonly setExpandedTurns: React.Dispatch<React.SetStateAction<BooleanMap>>;
  readonly focusedEventId: string | undefined;
  readonly setFocusedEventId: (props: { readonly id: string | undefined }) => void;
  // cardInnerTabs ...
  readonly toggleExpand: (props: { readonly id: string; readonly e?: React.MouseEvent }) => void;
  readonly expandAll: (props: { readonly _empty?: never }) => void;
  readonly collapseAll: (props: { readonly _empty?: never }) => void;
}
