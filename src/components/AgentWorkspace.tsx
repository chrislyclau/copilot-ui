import React, { useState } from 'react';
import { Send, Terminal, AlertCircle } from 'lucide-react';
import { VerificationFrame } from './VerificationFrame';
import { GateConfig } from '../types';

interface AgentWorkspaceProps {
  runWithGates: (config: GateConfig) => Promise<void>;
  isGateLoopRunning: boolean;
  activeScenarioId: string;
}

export function AgentWorkspace({ runWithGates, isGateLoopRunning, activeScenarioId }: AgentWorkspaceProps) {
  const [prompt, setPrompt] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleRun = async () => {
    if (!prompt.trim() || isGateLoopRunning) return;
    setErrorMsg('');
    try {
      await runWithGates({
        prompt,
        gates: ['tests', 'lint'],
        maxRetries: 2,
        sessionId: activeScenarioId,
        model: 'gemini-3.1-pro-preview',
        cwd: '.',
      });
      setPrompt('');
    } catch (err: unknown) {
      if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('An error occurred during execution.');
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleRun();
    }
  };

  return (
    <div className="flex flex-col h-full gap-1">
      <VerificationFrame />
      
      {/* Input area */}
      <div className="bg-white dark:bg-zinc-900/40 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-3 relative flex-shrink-0 focus-within:ring-2 focus-within:ring-sky-500/50 transition-all">
        {errorMsg && (
          <div className="mb-2 p-2 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
            <span className="text-xs text-rose-700 dark:text-rose-400 font-medium leading-relaxed">{errorMsg}</span>
          </div>
        )}
        <textarea
          className="w-full bg-transparent border-none focus:ring-0 text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 dark:placeholder-zinc-500 resize-none outline-none font-sans text-sm min-h-[80px]"
          placeholder="What would you like to build today? (e.g. 'Add a login page')"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isGateLoopRunning}
        />
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
          <div className="flex items-center gap-2">
            <Terminal className="text-zinc-400 w-4 h-4" />
            <span className="text-xs text-zinc-500 font-mono">Agent Environment</span>
          </div>
          <button
            onClick={handleRun}
            disabled={!prompt.trim() || isGateLoopRunning}
            className="bg-sky-500 hover:bg-sky-600 disabled:bg-zinc-300 dark:disabled:bg-zinc-800 disabled:text-zinc-500 text-white px-4 py-2 rounded-xl font-bold tracking-wide transition-colors flex items-center gap-2 text-sm"
          >
            <Send className="w-4 h-4" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
