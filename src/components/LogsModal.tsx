import React from 'react';
import { X, Copy, Terminal } from 'lucide-react';

interface LogsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly logs: string;
}

export default function LogsModal({ isOpen, onClose, logs }: LogsModalProps) {
  if (!isOpen) return null;
  
  const copyLogs = () => {
    navigator.clipboard.writeText(logs);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative bg-white dark:bg-slate-900 rounded-2xl w-full max-w-2xl shadow-xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[80vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <Terminal size={18} /> Debug Logs
                </h2>
                <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"><X size={18} /></button>
            </div>
            <pre className="p-6 overflow-auto text-xs font-mono text-slate-600 dark:text-slate-300 grow whitespace-pre-wrap">{logs}</pre>
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                <button onClick={copyLogs} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 cursor-pointer">
                    <Copy size={16} /> Copy to Clipboard
                </button>
            </div>
        </div>
    </div>
  );
}
