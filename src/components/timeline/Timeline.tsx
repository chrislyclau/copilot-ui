import React, { useEffect } from 'react';
import { Search, RotateCcw } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { CopilotEvent, TurnData } from '../../mockEvents';
import { EventCard } from './EventCard';
import { ActionHistoryGroup } from './ActionHistoryGroup';
import { FilterBar } from '../filters/FilterBar';
import { useTimeline } from '../../hooks/useTimeline';

interface TimelineProps {
  readonly activeScenarioId: string;
  readonly bundledEvents: readonly CopilotEvent[];
  readonly filteredEvents: readonly CopilotEvent[];
  readonly turnsData?: readonly TurnData[];
  readonly searchQuery: string;
  readonly setSearchQuery: (query: string) => void;
  readonly selectedCategory: string;
  readonly setSelectedCategory: (category: string) => void;
  readonly copiedText: string | undefined;
  readonly copyToClipboard: (text: string, label: string) => void;
  readonly onFocusedEventIdChange: (id: string | undefined) => void;
  readonly resumeAsHuman?: (input: string) => unknown;
  readonly isGateLoopRunning?: boolean;
}

export function Timeline({
  activeScenarioId,
  bundledEvents,
  filteredEvents,
  turnsData = [],
  searchQuery,
  setSearchQuery,
  selectedCategory,
  setSelectedCategory,
  copiedText,
  copyToClipboard,
  onFocusedEventIdChange,
  resumeAsHuman,
  isGateLoopRunning,
}: TimelineProps) {
  const {
    turns,
    expandedEvents,
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
    segmentActionHistory,
    expandAll,
    collapseAll,
  } = useTimeline(activeScenarioId, bundledEvents, filteredEvents, turnsData);

  useEffect(() => {
    onFocusedEventIdChange(focusedEventId);
  }, [focusedEventId, onFocusedEventIdChange]);

  const toggleActionHistory = (nodeId: string) => {
    setExpandedActionHistories(prev => ({
      ...prev,
      [nodeId]: !prev[nodeId],
    }));
  };

  const toggleCollapsedGroup = (snId: string) => {
    setExpandedCollapsedGroups(prev => ({
      ...prev,
      [snId]: !prev[snId],
    }));
  };

  const toggleTurn = (turnId: string) => {
    setExpandedTurns(prev => ({
      ...prev,
      [turnId]: !prev[turnId],
    }));
  };

  const handleRestore = async (commitSha: string, taskLabel: string) => {
    // We expect the active orchestrator state to determine if lock applies,
    // but the backend will handle that.
    try {
      const res = await fetch('/api/copilot/checkpoint/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeScenarioId, commitSha, taskLabel })
      });
      if (!res.ok) throw new Error('Failed to restore checkpoint');
      alert(`Checkpoint restored to ${commitSha.slice(0, 7)}`);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-4 min-w-0 flex-1">
      <FilterBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        expandAll={expandAll}
        collapseAll={collapseAll}
        selectedCategory={selectedCategory}
        setSelectedCategory={setSelectedCategory}
        events={bundledEvents}
      />
      
      <div id="timeline-stream-container" className="relative flex flex-col gap-3 py-3 mt-1 grow min-h-[400px]">
        <AnimatePresence initial={false}>
          {turns.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center bg-white dark:bg-zinc-900/40 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-xs my-4 grow">
              <Search size={28} className="text-zinc-400 dark:text-zinc-600 mb-3" />
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">No telemetry logs found</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm font-sans leading-relaxed">No items in this session matched your active filters. Try clearing your search text.</p>
            </div>
          ) : (
            turns.map((turn, tIdx) => {
              const isTurnExpanded = expandedTurns[turn.id] ?? true;

              return (
                <div key={turn.id} className="w-full flex flex-col mb-4">
                  
                  {/* TURN HEADER */}
                  <div 
                    className="flex flex-row items-center justify-between py-1 border-b border-zinc-100 dark:border-zinc-800/40 cursor-pointer hover:bg-zinc-50/50 dark:hover:bg-zinc-900/20 transition-colors rounded-t-lg px-2"
                    onClick={() => toggleTurn(turn.id)}
                  >
                    <div className="flex flex-row items-center justify-between w-full">
                    <div className="flex flex-row items-center gap-2">
                       <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                         Turn {tIdx + 1}
                       </span>
                       <span className="text-zinc-300 dark:text-zinc-600">/</span>
                      <span className="font-sans text-sm text-zinc-700 dark:text-zinc-300 font-medium">
                        {turn.taskLabel}
                      </span>
                    </div>
                    
                    <div className="flex flex-row items-center gap-3">
                      {turn.status === 'completed' && (
                        <span className="text-[10px] uppercase font-mono text-emerald-500 dark:text-emerald-400/80 font-medium">
                          Completed
                        </span>
                      )}
                      {turn.status === 'running' && (
                        <span className="text-[10px] uppercase font-mono text-sky-500 dark:text-sky-400 font-medium animate-pulse">
                          Running
                        </span>
                      )}
                      {turn.status === 'failed' && (
                        <span className="text-[10px] uppercase font-mono text-rose-500 dark:text-rose-400/80 font-medium">
                          Failed
                        </span>
                      )}
                       {turn.status === 'completed' && turn.commitSha && (
                         <button 
                           onClick={(e) => { e.stopPropagation(); handleRestore(turn.commitSha!, turn.taskLabel); }}
                           disabled={isGateLoopRunning}
                           className={`flex flex-row items-center gap-1.5 px-2 py-1 text-[11px] font-mono border border-slate-200 dark:border-slate-800 rounded shadow-sm ${
                             isGateLoopRunning 
                               ? 'opacity-50 cursor-not-allowed text-slate-400' 
                               : 'text-zinc-600 hover:text-zinc-800 bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-400 transition'
                           }`}
                         >
                           <RotateCcw size={12} />
                           Restore
                         </button>
                       )}
                    </div>
                    </div>
                  </div>

                  {/* TURN BODY */}
                  {isTurnExpanded && (
                    <div className="flex flex-col gap-2 pt-2">
                      {turn.nodes.map((node, nIdx) => {
                         if (node.type === 'conversational') {
                           const isCardExpanded = !!expandedEvents[node.event.sessionEvent.id];
                           const cardTab = cardInnerTabs[node.event.sessionEvent.id] || 'details';
                           return (
                             <div key={node.id} id={`timeline-node-${node.id}`} className="w-full">
                               <EventCard
                                 event={node.event}
                                 idx={nIdx}
                                 isNested={false}
                                 focusedEventId={focusedEventId}
                                 setFocusedEventId={setFocusedEventId}
                                 isExpanded={isCardExpanded}
                                 toggleExpand={(id, e) => toggleExpand({ id, e })}
                                 innerTab={cardTab}
                                 setTab={(id, tab) => setCardInnerTabs(prev => ({ ...prev, [id]: tab }))}
                                 copiedText={copiedText}
                                 copyToClipboard={copyToClipboard}
                                 resumeAsHuman={resumeAsHuman}
                               />
                             </div>
                           );
                         }

                         if (node.type === 'action_history') {
                           const isGroupExpanded = !!expandedActionHistories[node.id];
                           return (
                             <div key={node.id} id={`timeline-node-${node.id}`} className="w-full">
                               <ActionHistoryGroup
                                 id={node.id}
                                 events={node.events}
                                 isExpanded={isGroupExpanded}
                                 toggleExpandGroup={() => toggleActionHistory(node.id)}
                                 segmentActionHistory={segmentActionHistory}
                                 expandedCollapsedGroups={expandedCollapsedGroups}
                                 toggleCollapsedGroup={toggleCollapsedGroup}
                                 focusedEventId={focusedEventId}
                                 setFocusedEventId={setFocusedEventId}
                                 expandedEvents={expandedEvents}
                                 toggleExpandCard={(id, e) => toggleExpand({ id, e })}
                                 cardInnerTabs={cardInnerTabs}
                                 setTab={(id, tab) => setCardInnerTabs(prev => ({ ...prev, [id]: tab }))}
                                 copiedText={copiedText}
                                 copyToClipboard={copyToClipboard}
                                 resumeAsHuman={resumeAsHuman}
                               />
                             </div>
                           );
                         }

                         return null;
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
