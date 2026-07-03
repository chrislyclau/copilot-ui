import React, { useEffect, useState } from 'react';
import { FileCode, Activity } from 'lucide-react';
import Markdown from './Markdown';

interface GitFileStat {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

export function VerificationFrame() {
  const [diffData, setDiffData] = useState<{ readonly diff: string, readonly files: readonly GitFileStat[] } | undefined>(undefined);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDiff = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/git/diff');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }
      const data = await res.json();
      if (data.success) {
        setDiffData({ diff: data.diff, files: data.files });
      }
    } catch (err) {
      console.error('Failed to fetch git diff', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDiff();
  }, []);

  return (
    <div className="flex-1 flex flex-col gap-4 min-w-0 bg-white dark:bg-zinc-900/40 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-6 overflow-hidden relative">
      <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800/80 pb-4">
        <h2 className="text-lg font-bold font-sans text-zinc-900 dark:text-zinc-100 tracking-tight flex items-center gap-2">
          <FileCode className="w-5 h-5 text-sky-500" />
          Verification Frame
        </h2>
        <button
          onClick={fetchDiff}
          title="Refresh Diff"
          className="text-xs font-mono font-medium tracking-wide bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white px-3 py-1.5 rounded-lg transition"
        >
          Refresh Data
        </button>
      </div>

      <div className="flex-1 overflow-y-auto w-full pt-4 pr-2">
        {isLoading ? (
           <div className="flex flex-col items-center justify-center p-12 opacity-50">
             <Activity className="w-8 h-8 text-sky-500 animate-pulse mb-3" />
             <p className="text-sm text-zinc-500 font-medium">Computing workspace diff...</p>
           </div>
        ) : diffData && diffData.files.length > 0 ? (
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wider font-sans">
              Modified Files in Active HEAD
            </h3>
            <div className="flex flex-col gap-2">
              {diffData.files.map(stat => (
                <div key={stat.file} className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-800/50 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700">
                  <span className="font-mono text-sm text-zinc-800 dark:text-zinc-200 truncate pr-4">
                    {stat.file}
                  </span>
                  <div className="flex items-center gap-3 shrink-0 text-xs font-bold font-mono">
                    <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>
                    <span className="text-rose-600 dark:text-rose-400">-{stat.removed}</span>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => setShowFullDiff(!showFullDiff)}
              className="mt-4 bg-sky-50 dark:bg-sky-500/10 hover:bg-sky-100 dark:hover:bg-sky-500/20 text-sky-600 dark:text-sky-400 w-full py-3 rounded-xl font-semibold font-sans transition-colors"
            >
              {showFullDiff ? 'Hide Turn Diff' : 'View Turn Diff'}
            </button>

            {showFullDiff && diffData.diff && (
              <div className="mt-4 bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800">
                <div className="bg-zinc-900 px-4 py-2 border-b border-zinc-800 text-xs font-mono text-zinc-400">
                  Unified Diff view
                </div>
                <div className="p-4 overflow-x-auto">
                  <pre className="text-xs font-mono text-zinc-300 whitespace-pre">
                    {diffData.diff}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-12 text-center h-full">
            <FileCode size={32} className="text-zinc-300 dark:text-zinc-700 mb-4" />
            <h3 className="text-zinc-700 dark:text-zinc-300 font-semibold mb-1">No Changes Detected</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm leading-relaxed">
              The verification frame computes diff structures directly from the workspace's active Git HEAD. Currently, your working tree is perfectly clean.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
