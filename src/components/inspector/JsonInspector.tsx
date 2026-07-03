import React from 'react';
import { Database, Copy, Check, Layers } from 'lucide-react';
import { CopilotEvent } from '../../mockEvents';

interface JsonInspectorProps {
  readonly activeFocusEvent: CopilotEvent | undefined;
  readonly copiedText: string | undefined;
  readonly copyToClipboard: (text: string, label: string) => void;
}

export function JsonInspector({
  activeFocusEvent,
  copiedText,
  copyToClipboard,
}: JsonInspectorProps) {
  return (
    <div id="json-inspector-panel" className="bg-[#1e1e20] rounded-2xl p-4 border border-zinc-800/85 shadow-xs flex flex-col min-h-[300px] grow shrink-0">
      <h3 className="text-xs font-bold text-zinc-300 dark:text-zinc-200 uppercase font-sans tracking-wide mb-2 flex items-center gap-1.5 border-b border-zinc-800 pb-2">
        <Database size={15} className="text-sky-500" />
        <span>Diagnostics JSON Inspector</span>
      </h3>

      {activeFocusEvent ? (
        <div className="flex flex-col gap-3 grow">
          <div className="flex items-center justify-between text-xs bg-zinc-950/20 p-2 rounded-lg border border-zinc-800 flex-wrap gap-2">
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-sky-505 animate-pulse"></span>
              <span className="font-sans text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold">Active key:</span>
              <code className="font-bold text-zinc-200 font-mono text-[10.5px]">{activeFocusEvent.sessionEvent.id}</code>
            </div>
            <button
              id="copy-inspector-json"
              onClick={() => copyToClipboard(JSON.stringify(activeFocusEvent, null, 2), 'active-inspector')}
              className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-all cursor-pointer whitespace-nowrap ml-auto font-bold"
              title="Copy full active JSON trace to clipboard"
            >
              {copiedText === 'active-inspector' ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
              <span>{copiedText === 'active-inspector' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <div className="bg-[#131314] rounded-xl p-3 border border-zinc-900 overflow-auto max-h-[380px] grow font-mono text-[11px] leading-relaxed relative text-left">
            <pre className="text-sky-300 block whitespace-pre max-w-full font-mono">
              {JSON.stringify(activeFocusEvent, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center grow text-center text-zinc-500 p-8 select-none font-sans">
          <Layers size={22} className="text-zinc-600 dark:text-zinc-500 mb-2" />
          <p className="text-xs font-semibold text-zinc-400">No active trace focused.</p>
          <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">Select any item in the scrollable timeline feed to inspect its full trace payload JSON parameters tree hierachy list here.</p>
        </div>
      )}
    </div>
  );
}
