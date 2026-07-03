import { useState, useMemo, useEffect, useRef } from 'react';
import { CopilotEvent, TurnData } from '../mockEvents';
import { ExtendedSessionEvent } from '../types/events';

export interface TurnNode {
  readonly type: 'turn';
  readonly id: string;
  readonly taskLabel: string;
  readonly commitSha: string | undefined;
  readonly status: 'running' | 'completed' | 'failed';
  readonly events: readonly CopilotEvent[];
  readonly nodes: readonly TimelineNode[];
}

export interface ActionHistoryGroupNode {
  readonly type: 'action_history';
  readonly id: string;
  readonly events: readonly CopilotEvent[];
}

export interface ConversationalNode {
  readonly type: 'conversational';
  readonly id: string;
  readonly event: CopilotEvent;
}

export type TimelineNode = ConversationalNode | ActionHistoryGroupNode;

export interface SegmentedNode {
  readonly id: string;
  readonly type: 'thinking' | 'tool' | 'collapsed';
  readonly event?: CopilotEvent;
  readonly events?: readonly CopilotEvent[];
}

export function useTimeline(
  activeScenarioId: string,
  bundledEvents: readonly CopilotEvent[],
  filteredEvents: readonly CopilotEvent[],
  turnsData: readonly TurnData[] = []
) {
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [expandedActionHistories, setExpandedActionHistories] = useState<Record<string, boolean>>({});
  const [expandedCollapsedGroups, setExpandedCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [focusedEventId, setFocusedEventId] = useState<string | undefined>(undefined);
  const [cardInnerTabs, setCardInnerTabs] = useState<Record<string, 'details' | 'json' | 'stream' | undefined>>({});

  const lastStatusesRef = useRef<Record<string, 'running' | 'completed' | 'failed'>>({});

  useEffect(() => {
    const defaultExpansions: Record<string, boolean> = {};
    const defaultTabs: Record<string, 'details' | 'json' | 'stream'> = {};
    
    bundledEvents.forEach(evt => {
      const id = evt.sessionEvent?.id || `evt-${Math.random().toString(36).substring(7)}`;
      const type = evt.sessionEvent?.type;
      if (type === 'assistant.message' || type === 'user.message') {
        defaultExpansions[id] = true;
      } else {
        defaultExpansions[id] = false;
      }
      if (evt.isBundle) {
        defaultTabs[id] = 'details';
      }
    });
    
    setExpandedEvents(defaultExpansions);
    setCardInnerTabs(prev => ({ ...prev, ...defaultTabs }));
    
    if (bundledEvents.length > 0) {
      setFocusedEventId(bundledEvents[0]!.sessionEvent.id);
    } else {
      setFocusedEventId(undefined);
    }
  }, [activeScenarioId, bundledEvents]);

  const toggleExpand = (props: { readonly id: string; readonly e?: React.MouseEvent }) => {
    const { id, e } = props;
    if (e) e.stopPropagation();
    setExpandedEvents(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const turns = useMemo(() => {
    const buildNodesForTurn = (events: readonly CopilotEvent[]): readonly TimelineNode[] => {
      let history: CopilotEvent[] = [];
      const nodes: TimelineNode[] = [];
      const flush = () => {
        if (history.length === 0) return;
        nodes.push({
          type: 'action_history',
          id: `action-history-${history[0]?.sessionEvent.id || 'err'}`,
          events: [...history]
        });
        history = [];
      };

      events.forEach(evt => {
        const type = evt.sessionEvent.type as any;
        const isRootEvent = 
          type === 'user.message' || 
          type === 'assistant.message' || 
          type === 'turn.start' ||
          type === 'subtask.start' ||
          type === 'TURN_COMPLETED' ||
          type === 'subtask.complete' ||
          type === 'gate.start' ||
          type === 'gate.result' || 
          type === 'tool.execution_start' || 
          type === 'tool.execution_complete' ||
          type === 'loop.error' ||
          type === 'session.error';

        if (isRootEvent) {
          flush();
          nodes.push({
            type: 'conversational',
            id: evt.sessionEvent.id,
            event: evt
          });
        } else {
          history.push(evt);
        }
      });
      flush();
      return nodes;
    };

    // If we have pre-grouped turns from state, use them
    if (turnsData && turnsData.length > 0) {
      return turnsData.map((t): TurnNode => ({
        type: 'turn',
        id: t.id,
        taskLabel: t.taskLabel,
        commitSha: t.commitSha || undefined,
        status: t.status,
        events: t.events,
        nodes: buildNodesForTurn(t.events)
      }));
    }

    // Fallback to inference logic for flat event streams
    const turnList: TurnNode[] = [];
    let turnCounter = 1;

    let accumulatedEvents: CopilotEvent[] = [];
    let taskLabel = 'Processing Request...';
    let commitSha: string | undefined = undefined;
    let status: 'running' | 'completed' | 'failed' = 'running';
    let hasActiveTurn = false;

    const finalizeTurn = () => {
      if (hasActiveTurn) {
        turnList.push({
          type: 'turn',
          id: `turn-${turnCounter++}`,
          taskLabel,
          commitSha,
          status,
          events: [...accumulatedEvents],
          nodes: buildNodesForTurn(accumulatedEvents)
        });
        accumulatedEvents = [];
        taskLabel = 'Processing Request...';
        commitSha = undefined;
        status = 'running';
        hasActiveTurn = false;
      }
    };

    filteredEvents.forEach(evt => {
      const type = evt.sessionEvent.type;
      hasActiveTurn = true;
      accumulatedEvents.push(evt);

      if (type === 'TURN_COMPLETED') {
        const data = (evt.sessionEvent as ExtendedSessionEvent).data;
        if (data && typeof data === 'object' && 'taskLabel' in data) {
          const d = data as { readonly taskLabel?: string; readonly commitSha?: string };
          if (d.taskLabel) taskLabel = d.taskLabel;
          if (d.commitSha) commitSha = d.commitSha;
          status = 'completed';
        }
        finalizeTurn();
      } else if (type === 'loop.escalate_human' || type === 'loop.error') {
        status = 'failed';
        finalizeTurn();
      }
    });

    finalizeTurn();
    return turnList;
  }, [filteredEvents, turnsData]);

  useEffect(() => {
    let changed = false;
    const nextTurns = { ...expandedTurns };
    const nextActionHistories = { ...expandedActionHistories };
    const nextEvents = { ...expandedEvents };
    let newFocusId: string | null = null;

    turns.forEach((t) => {
      const prevStatus = lastStatusesRef.current[t.id];
      if (prevStatus !== t.status) {
        lastStatusesRef.current[t.id] = t.status;
        changed = true;

        if (t.status === 'completed') {
          // "Summary Only" State: By default, if a Turn completes successfully, it auto-collapses
          nextTurns[t.id] = false;
        } else if (t.status === 'failed') {
          // "Auto-Expand on Exception" Trigger: If it failed, force expand the turn card
          nextTurns[t.id] = true;
          
          // Find the failed gate result or exception event
          const failedEvent = t.events.find(
            e => (e.sessionEvent.type === 'gate.result' && (e.sessionEvent.data as any)?.pass === false) ||
                 (e.sessionEvent.type === 'loop.error')
          );
          if (failedEvent) {
            const feId = failedEvent.sessionEvent.id;
            nextEvents[feId] = true;
            newFocusId = feId;

            // Expand the specific action history group surrounding this event
            t.nodes.forEach(node => {
              if (node.type === 'action_history' && node.events.some(ev => ev.sessionEvent.id === feId)) {
                nextActionHistories[node.id] = true;
              }
            });
          }
        } else if (t.status === 'running') {
          // Keep active/running turn open
          nextTurns[t.id] = true;
        }
      }
    });

    if (changed) {
      setExpandedTurns(nextTurns);
      setExpandedActionHistories(nextActionHistories);
      setExpandedEvents(nextEvents);
      if (newFocusId) {
        setFocusedEventId(newFocusId);
      }
    }
  }, [turns]);

  const segmentActionHistory = (events: readonly CopilotEvent[]) => {
    const nodes: SegmentedNode[] = [];
    let currentCollapsed: CopilotEvent[] = [];

    const flushCollapsed = () => {
      if (currentCollapsed.length === 0) return;
      nodes.push({
        id: `collapsed-group-${currentCollapsed[0]?.sessionEvent.id || 'err'}`,
        type: 'collapsed',
        events: [...currentCollapsed]
      });
      currentCollapsed = [];
    };

    events.forEach(evt => {
      const type = evt.sessionEvent.type;
      const isTool = type.startsWith('tool.');
      const isThinking = type === 'assistant.reasoning' || type.includes('reasoning');

      if (isTool || isThinking) {
        flushCollapsed();
        nodes.push({
          id: evt.sessionEvent.id,
          type: isThinking ? 'thinking' : 'tool',
          event: evt
        });
      } else {
        currentCollapsed.push(evt);
      }
    });

    flushCollapsed();
    return nodes;
  };

  const expandAll = (props: { readonly _empty?: never } = {}) => {
    const updated: Record<string, boolean> = {};
    const updatedActionHistories: Record<string, boolean> = {};
    const updatedCollapsedGroups: Record<string, boolean> = {};
    const updatedTurns: Record<string, boolean> = {};

    bundledEvents.forEach(evt => {
      updated[evt.sessionEvent.id] = true;
    });

    turns.forEach(t => {
      updatedTurns[t.id] = true;
      t.nodes.forEach(node => {
        if (node.type === 'action_history') {
          updatedActionHistories[node.id] = true;
          segmentActionHistory(node.events).forEach(sn => {
            if (sn.type === 'collapsed') {
              updatedCollapsedGroups[sn.id] = true;
            }
          });
        }
      });
    });

    setExpandedEvents(updated);
    setExpandedActionHistories(updatedActionHistories);
    setExpandedCollapsedGroups(updatedCollapsedGroups);
    setExpandedTurns(updatedTurns);
  };

  const collapseAll = (props: { readonly _empty?: never } = {}) => {
    const updated: Record<string, boolean> = {};
    bundledEvents.forEach(evt => {
      const type = evt.sessionEvent.type;
      if (type === 'assistant.message' || type === 'user.message') {
        updated[evt.sessionEvent.id] = true;
      } else {
        updated[evt.sessionEvent.id] = false;
      }
    });
    setExpandedEvents(updated);
    setExpandedActionHistories({});
    setExpandedCollapsedGroups({});
    const updatedTurns: Record<string, boolean> = {};
    turns.forEach(t => {
      // expand the most recent turn by default perhaps, or collapse all turns
      updatedTurns[t.id] = false;
    });
    setExpandedTurns(updatedTurns);
  };

  return {
    expandedEvents,
    setExpandedEvents,
    expandedActionHistories,
    setExpandedActionHistories,
    expandedCollapsedGroups,
    setExpandedCollapsedGroups,
    expandedTurns,
    setExpandedTurns,
    focusedEventId,
    setFocusedEventId,
    cardInnerTabs,
    setCardInnerTabs,
    toggleExpand,
    turns,
    segmentActionHistory,
    expandAll,
    collapseAll,
  };
}
