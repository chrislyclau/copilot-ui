import React from 'react';

interface AmbientStatusStripProps {
  readonly isRunning: boolean;
  readonly currentTier: string;
  readonly retryCount: number;
  readonly activeGate: string | undefined;
  readonly awaitingHuman: boolean;
  readonly activeOutput?: string;
}

export function AmbientStatusStrip({
  isRunning,
  currentTier,
  retryCount,
  activeGate,
  awaitingHuman,
  activeOutput
}: AmbientStatusStripProps) {
  if (!isRunning && !awaitingHuman) return null;

  return (
    <div className={`w-full px-4 py-2 border-b text-xs flex items-center justify-between font-mono transition-colors duration-300 ${
      awaitingHuman 
        ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300' 
        : 'bg-zinc-50 dark:bg-zinc-900/20 border-zinc-200 dark:border-zinc-800/80 text-zinc-800 dark:text-zinc-200 font-medium'
    }`}>
      <div className="flex items-center gap-4 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-sans shrink-0">
          <span className={`w-2 h-2 rounded-full ${awaitingHuman ? 'bg-amber-500 animate-pulse' : 'bg-sky-500 animate-pulse'}`} />
          <span className="font-bold uppercase text-[10.5px] tracking-wide">{awaitingHuman ? 'Action Required' : 'Loop Autonomous'}</span>
        </div>
        
        <div className="shrink-0">
          <span className="text-zinc-500 dark:text-zinc-400 font-medium font-sans">Layer:</span>{' '}
          <span className="text-zinc-800 dark:text-zinc-200">{currentTier}</span>
        </div>

        {activeGate && (
          <div className="shrink-0">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium font-sans">Active Guard:</span>{' '}
            <span className="px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-[10px] font-semibold">
              {activeGate}
            </span>
          </div>
        )}

        {activeOutput && (
          <div className="hidden md:flex items-center gap-1.5 max-w-[200px] lg:max-w-[400px] min-w-0 truncate">
            <span className="text-zinc-500 dark:text-zinc-400 font-medium font-sans shrink-0">Stream:</span>
            <span className="text-[10px] text-sky-600 dark:text-sky-400 font-mono truncate animate-pulse" title={activeOutput}>
              {activeOutput}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div>
          <span className="text-zinc-500 dark:text-zinc-400 font-medium font-sans">Mitigation Cycles:</span>{' '}
          <span className={`${retryCount > 0 ? 'text-amber-600 font-bold' : 'text-zinc-700 dark:text-zinc-300'}`}>
            {retryCount}
          </span>
        </div>
      </div>
    </div>
  );
}
