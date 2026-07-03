import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { CopilotEvent } from '../../mockEvents';

interface CollapsedOthersRowProps {
  readonly id: string;
  readonly collapsedEvents: readonly CopilotEvent[];
  readonly isExpanded: boolean;
  readonly toggleExpand: () => void;
  readonly focusedEventId: string | undefined;
  readonly setFocusedEventId: (id: string | undefined) => void;
}

export function CollapsedOthersRow({
  id,
  collapsedEvents,
  isExpanded,
  toggleExpand,
  focusedEventId,
  setFocusedEventId,
}: CollapsedOthersRowProps) {
  return (
    <div className="border-l border-dashed border-slate-200 dark:border-slate-800 pl-4 py-1.5 relative">
      {/* Bullet dot */}
      <div className="absolute left-[-4.5px] top-[14px] w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700" />
      
      <button
        id={`btn-collapsed-toggle-${id}`}
        onClick={toggleExpand}
        className="w-full flex items-center justify-between text-left text-[10.5px] text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-slate-100 cursor-pointer p-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 select-none font-mono"
      >
        <div className="flex items-center gap-1.5 font-bold">
          {isExpanded ? <ChevronDown size={11.5} className="text-slate-600 dark:text-slate-400" /> : <ChevronRight size={11.5} className="text-slate-600 dark:text-slate-400" />}
          <span>{isExpanded ? 'Hide' : 'Show'} {collapsedEvents.length} other standard trace {collapsedEvents.length === 1 ? 'event' : 'events'}</span>
          <span className="text-[9.5px] font-bold text-slate-600 dark:text-slate-350 italic">({collapsedEvents.map(e => e.sessionEvent.type.split('.').pop()).join(', ')})</span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 flex flex-col gap-2 pl-2 overflow-hidden"
          >
            {collapsedEvents.map((subEvent) => {
              const subId = subEvent.sessionEvent.id;
              const isFocused = focusedEventId === subId;
              return (
                <div
                  key={subId}
                  id={`collapsed-sub-event-${subId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocusedEventId(subId);
                  }}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer text-left ${
                    isFocused
                      ? 'bg-slate-50 border-slate-300/80 dark:bg-slate-950 dark:border-slate-700 shadow-xs'
                      : 'bg-white border-slate-150 hover:bg-slate-50/50 dark:bg-slate-900 dark:border-slate-800/80 dark:hover:bg-slate-850'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] bg-slate-150 dark:bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-700 dark:text-slate-300 font-bold">
                        {subEvent.sessionEvent.type}
                      </span>
                      <span className="text-[10.5px] font-semibold text-slate-700 dark:text-slate-300">
                        {subEvent.title}
                      </span>
                    </div>
                    <span className="text-[9.5px] font-mono text-slate-605 dark:text-slate-350 font-semibold">
                      {new Date(subEvent.sessionEvent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
