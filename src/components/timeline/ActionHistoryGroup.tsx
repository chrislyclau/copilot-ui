import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cpu, ChevronDown } from 'lucide-react';
import { CopilotEvent } from '../../mockEvents';
import { SegmentedNode } from '../../hooks/useTimeline';
import { CollapsedOthersRow } from './CollapsedOthersRow';
import { EventCard } from './EventCard';

interface ActionHistoryGroupProps {
  readonly id: string;
  readonly events: readonly CopilotEvent[];
  readonly isExpanded: boolean;
  readonly toggleExpandGroup: () => void;
  readonly segmentActionHistory: (events: readonly CopilotEvent[]) => readonly SegmentedNode[];
  readonly expandedCollapsedGroups: Record<string, boolean | undefined>;
  readonly toggleCollapsedGroup: (id: string) => void;
  readonly focusedEventId: string | undefined;
  readonly setFocusedEventId: (id: string | undefined) => void;
  readonly expandedEvents: Record<string, boolean | undefined>;
  readonly toggleExpandCard: (id: string, e?: React.MouseEvent) => void;
  readonly cardInnerTabs: Record<string, 'details' | 'json' | 'stream' | undefined>;
  readonly setTab: (id: string, tab: 'details' | 'json' | 'stream') => void;
  readonly copiedText: string | undefined;
  readonly copyToClipboard: (text: string, label: string) => void;
  readonly resumeAsHuman?: (input: string) => unknown;
}

export function ActionHistoryGroup({
  id,
  events,
  isExpanded,
  toggleExpandGroup,
  segmentActionHistory,
  expandedCollapsedGroups,
  toggleCollapsedGroup,
  focusedEventId,
  setFocusedEventId,
  expandedEvents,
  toggleExpandCard,
  cardInnerTabs,
  setTab,
  copiedText,
  copyToClipboard,
  resumeAsHuman,
}: ActionHistoryGroupProps) {
  const totalCount = events.length;
  const toolCount = events.filter(e => e.sessionEvent.type.startsWith('tool.')).length;
  const thoughtCount = events.filter(e => e.sessionEvent.type === 'assistant.reasoning' || e.sessionEvent.type.includes('reasoning')).length;
  const otherCount = totalCount - toolCount - thoughtCount;

  const durationStr = React.useMemo(() => {
    if (events.length === 0) return '';
    const firstTime = new Date(events[0]?.sessionEvent.timestamp || '');
    const lastTime = new Date(events[events.length - 1]?.sessionEvent.timestamp || '');
    const diffSec = Math.max(0, Math.round((lastTime.getTime() - firstTime.getTime()) / 1000));
    return diffSec > 0 ? `${diffSec}s` : '';
  }, [events]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.18 }}
      className="relative flex flex-col items-start w-full text-left my-2"
    >
      <div
        id={`action-history-wrapper-${id}`}
        className="w-full transition-all duration-150 cursor-pointer group"
        onClick={(e) => {
          e.stopPropagation();
          toggleExpandGroup();
        }}
      >
        <div className="flex items-center justify-between gap-3 select-none py-1.5 px-2 -ml-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800/50">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center text-zinc-400 dark:text-zinc-500 shrink-0 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors">
              <ChevronDown size={14} className={`transform transition-transform duration-200 ${isExpanded ? 'rotate-180' : '-rotate-90'}`} />
            </div>
            <div className="text-left flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Action History
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                {totalCount} event{totalCount !== 1 ? 's' : ''}
              </span>
              {durationStr && (
                <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-zinc-400 dark:text-zinc-500 font-mono ml-2">
                  {durationStr}
                </span>
              )}
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="mt-1"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              <div className="flex flex-col gap-1 pl-4 ml-2 border-l-2 border-zinc-100 dark:border-zinc-800/60">
                {segmentActionHistory(events).map((subNode, subIdx) => {
                  if (subNode.type === 'collapsed' && subNode.events) {
                    return (
                      <div key={subNode.id}>
                        <CollapsedOthersRow
                          id={subNode.id}
                          collapsedEvents={subNode.events}
                          isExpanded={!!expandedCollapsedGroups[subNode.id]}
                          toggleExpand={() => toggleCollapsedGroup(subNode.id)}
                          focusedEventId={focusedEventId}
                          setFocusedEventId={setFocusedEventId}
                        />
                      </div>
                    );
                  } else if (subNode.event) {
                    return (
                      <div key={subNode.event.sessionEvent.id}>
                        <EventCard
                          event={subNode.event}
                          idx={subIdx}
                          isNested={true}
                          focusedEventId={focusedEventId}
                          setFocusedEventId={setFocusedEventId}
                          isExpanded={!!expandedEvents[subNode.event.sessionEvent.id]}
                          toggleExpand={toggleExpandCard}
                          innerTab={cardInnerTabs[subNode.event.sessionEvent.id] || 'details'}
                          setTab={setTab}
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
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
