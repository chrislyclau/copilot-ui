import React from 'react';
import { Sparkles, Terminal, Layers } from 'lucide-react';
import { Scenario } from '../../mockEvents';

interface HeaderProps {
  readonly scenarios: readonly Scenario[];
  readonly activeScenarioId: string;
  readonly setActiveScenarioId: (id: string) => void;
  readonly fetchLogs: () => void;
  readonly activeReplayTraceId?: string | undefined;
  readonly onOpenTerminal?: () => void;
}

export function Header({
  scenarios,
  activeScenarioId,
  setActiveScenarioId,
  fetchLogs,
  activeReplayTraceId,
  onOpenTerminal,
}: HeaderProps) {
  return (
    <header className="bg-white dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800 shrink-0 sticky top-0 z-40 backdrop-blur-sm">
      <div className="w-full mx-auto px-6 py-3 flex flex-col md:flex-row items-center justify-between gap-4">
        
        {/* Brand logo & identity */}
        <div className="flex items-center gap-4">
          <div id="header-brand" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500 shrink-0 shadow-xs">
              <Sparkles size={18} className="fill-sky-500/10 stroke-[2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 id="app-title" className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Agent Studio</h1>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 font-sans font-medium">Focused AI Development Environment</p>
            </div>
          </div>

          {activeReplayTraceId && (
            <div id="ambient-replay-badge" className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 font-bold font-mono text-[10px] rounded-full animate-pulse uppercase tracking-wider shrink-0 select-none">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span>● SHADOW REPLAY MODE ACTIVE</span>
            </div>
          )}
        </div>

        {/* Scenario / Session dataset selector dropdown */}
        <div className="flex items-center gap-2">
          {onOpenTerminal && (
            <button
              id="btn-open-terminal"
              onClick={onOpenTerminal}
              className="px-3 py-1.5 bg-zinc-900 dark:bg-zinc-800 text-white border border-zinc-700/60 rounded-xl text-xs font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-700 cursor-pointer flex items-center gap-2 shadow-2xs transition-colors"
            >
              <Terminal size={14} className="text-[#00FF41]" /> Dev Terminal
            </button>
          )}
          <button
            id="btn-view-logs"
            onClick={fetchLogs}
            className="px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer flex items-center gap-2 shadow-2xs transition-colors"
          >
            <Terminal size={14} /> View Logs
          </button>
          <div className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-950 px-3 py-1.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 w-full md:w-auto">
            <Layers size={14} className="text-zinc-600 dark:text-zinc-400 shrink-0" />
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 hidden lg:inline">Active Session:</span>
            <select
              id="select-scenario"
              value={activeScenarioId}
              onChange={(e) => setActiveScenarioId(e.target.value)}
              className="bg-transparent border-none text-xs font-semibold text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-0 cursor-pointer pr-4 grow font-sans"
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id} className="dark:bg-zinc-900">
                  {scenario.name}
                </option>
              ))}
            </select>
          </div>
        </div>

      </div>
    </header>
  );
}
