import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HelpCircle,
  User,
  Bot,
  Terminal,
  Lock,
  ShieldAlert,
  Settings,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Code,
  Eye,
  Copy,
  Check,
  FolderOpen,
  Layers,
  Sparkles,
  ClipboardList,
  Activity,
  Play,
  ListTodo
} from 'lucide-react';
import { CopilotEvent } from '../../mockEvents';
import { parseEvent, extractAssistantText } from '../../parser';
import Markdown from '../Markdown';

interface EventCardProps {
  readonly event: CopilotEvent;
  readonly idx: number;
  readonly isNested?: boolean;
  readonly focusedEventId: string | undefined;
  readonly setFocusedEventId: (id: string | undefined) => void;
  readonly isExpanded: boolean;
  readonly toggleExpand: (id: string, e?: React.MouseEvent) => void;
  readonly innerTab: 'details' | 'json' | 'stream' | undefined;
  readonly setTab: (id: string, tab: 'details' | 'json' | 'stream') => void;
  readonly copiedText: string | undefined;
  readonly copyToClipboard: (text: string, label: string) => void;
  readonly resumeAsHuman?: (input: string) => unknown;
}

export function EventCard({
  event,
  idx,
  isNested = false,
  focusedEventId,
  setFocusedEventId,
  isExpanded,
  toggleExpand,
  innerTab,
  setTab,
  copiedText,
  copyToClipboard,
  resumeAsHuman,
}: EventCardProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | undefined>(undefined);
  const normalizedType = event.sessionEvent.type;
  const eventData = (event.sessionEvent.data || {}) as any;
  const isFocused = event.sessionEvent.id === focusedEventId;
  const timestampStr = new Date(event.sessionEvent.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const {
    pText,
    pPrompt,
    pAttachments,
    pSessionId,
    pWorkingDirectory,
    pClientName,
    pModel,
    pClientMode,
    pSysSections,
    pToolCallId,
    pToolName,
    pArguments,
    pResultType,
    pExecutionMs,
    pError,
    pTextResult,
    pBinaryResults,
    pThought,
    pEffort,
    pFileName,
    pKind,
    pDiff,
    pDecision,
    pComments,
    pDetails,
    pReason,
    pSummary,
  } = parseEvent(event);

  const binaryItems = pBinaryResults as Array<{ mimeType?: string; description?: string; data?: string }>;

  // Categorized styles & icon configurations
  let avatarBg = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300';
  let nodeBorder = 'hover:border-zinc-350 dark:hover:border-zinc-700';
  let badgeStyle = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300';
  let NodeIcon = HelpCircle;

  if (event.category === 'user') {
    avatarBg = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-350 border border-zinc-250 dark:border-zinc-700 shadow-2xs';
    nodeBorder = isFocused ? 'border-zinc-400 dark:border-zinc-600' : 'hover:border-zinc-200 dark:hover:border-zinc-800';
    badgeStyle = 'bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-350 border border-zinc-250 dark:border-zinc-800';
    NodeIcon = User;
  } else if (event.category === 'assistant') {
    avatarBg = 'bg-sky-500/10 text-sky-500 border border-sky-550/20 shadow-xs';
    nodeBorder = isFocused ? 'border-sky-500/30' : 'hover:border-sky-500/10';
    badgeStyle = 'bg-sky-50 dark:bg-sky-950/20 text-sky-600 dark:text-sky-350 border border-sky-100/50 dark:border-sky-900/40';
    NodeIcon = Sparkles;
  } else if (event.category === 'tool') {
    avatarBg = 'bg-amber-500 text-white shadow-xs';
    nodeBorder = isFocused ? 'border-amber-500 dark:border-amber-400' : 'hover:border-amber-200 dark:hover:border-amber-900';
    badgeStyle = 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-100 dark:border-amber-900/50';
    NodeIcon = Terminal;
  } else if (event.category === 'permission') {
    avatarBg = 'bg-purple-600 text-white shadow-xs';
    nodeBorder = isFocused ? 'border-purple-600 dark:border-purple-500' : 'hover:border-purple-200 dark:hover:border-purple-900';
    badgeStyle = 'bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-400 border border-purple-100 dark:border-purple-950/50';
    NodeIcon = Lock;
  } else if (event.category === 'error') {
    avatarBg = 'bg-rose-600 text-white shadow-xs';
    nodeBorder = isFocused ? 'border-rose-600 dark:border-rose-500' : 'hover:border-rose-200 dark:hover:border-rose-900';
    badgeStyle = 'bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-400 border border-rose-100 dark:border-rose-900/50';
    NodeIcon = ShieldAlert;
  } else if (event.category === 'system') {
    avatarBg = 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-350 shadow-2xs';
    nodeBorder = isFocused ? 'border-zinc-400 dark:border-zinc-700' : 'hover:border-zinc-300 dark:hover:border-zinc-800';
    badgeStyle = 'bg-zinc-100 border border-zinc-200 dark:bg-zinc-850 text-zinc-700 dark:text-zinc-300 dark:border-zinc-750';
    NodeIcon = Settings;
  }

  if ((normalizedType as any) === 'composer.plan_mutated') {
    avatarBg = 'bg-amber-500 text-white shadow-md animate-bounce';
    nodeBorder = isFocused 
      ? 'border-amber-500 dark:border-amber-400 shadow-lg shadow-amber-500/10' 
      : 'border-amber-400 dark:border-amber-800 border-2 shadow-sm hover:border-amber-400/80 dark:hover:border-amber-700/80';
    badgeStyle = 'bg-amber-100 dark:bg-amber-950/45 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800/60';
    NodeIcon = Sparkles;
  }

  if (normalizedType === 'tool.execution_complete' || (normalizedType as any) === 'loop.complete') {
    if (pResultType === 'success') {
      NodeIcon = CheckCircle2;
    } else if (pResultType === 'failure' || pResultType === 'error') {
      NodeIcon = XCircle;
    } else if (pResultType === 'denied') {
      NodeIcon = ShieldAlert;
    }
  }

  if ((normalizedType as any) === 'gate.start') {
    NodeIcon = Activity;
    avatarBg = 'bg-amber-500/10 text-amber-500 border border-amber-500/20';
  }

  if ((normalizedType as any) === 'gate.result') {
    const isPass = (event.sessionEvent.data as any)?.pass;
    NodeIcon = isPass ? CheckCircle2 : XCircle;
    avatarBg = isPass 
      ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' 
      : 'bg-rose-500/10 text-rose-500 border border-rose-500/20';
  }

  if ((normalizedType as any) === 'turn.start' || (normalizedType as any) === 'TURN_COMPLETED') {
    NodeIcon = Play;
    avatarBg = 'bg-stone-500/10 text-stone-500 border border-stone-500/20';
    if ((normalizedType as any) === 'TURN_COMPLETED') {
      NodeIcon = CheckCircle2;
    }
  }

  if ((normalizedType as any) === 'subtask.start' || (normalizedType as any) === 'subtask.complete') {
    NodeIcon = ListTodo;
    avatarBg = 'bg-indigo-500/10 text-indigo-500 border border-indigo-500/20';
    if ((normalizedType as any) === 'subtask.complete') {
      NodeIcon = CheckCircle2;
      const pass = (event.sessionEvent as any).success;
      if (pass === false) {
        NodeIcon = XCircle;
        avatarBg = 'bg-rose-500/10 text-rose-500 border border-rose-500/20';
      }
    }
  }

  if ((normalizedType as any) === 'composer.plan') {
    NodeIcon = ClipboardList;
  }

  if ((normalizedType as any) === 'composer.plan_mutated') {
    NodeIcon = Sparkles;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.18, delay: Math.min(idx * 0.03, 0.3) }}
      className={`relative flex flex-col gap-2 w-full text-left bg-transparent ${isFocused ? 'z-10' : ''}`}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        setFocusedEventId(event.sessionEvent.id);
      }}
    >
      <div className={`w-full overflow-hidden transition-all duration-150 group`}>
        <div className="px-1 py-1 flex items-start gap-3 select-none">
          {!isNested && (
            <div className={`mt-0.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${avatarBg}`}>
              <NodeIcon size={event.category === 'system' ? 12 : 14} className="shrink-0" />
            </div>
          )}

          <div className="flex flex-col gap-0.5 w-full">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs w-full">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  {event.title}
                  {normalizedType === 'tool.execution_start' && pToolName && (
                    <span className="text-slate-500 text-xs font-mono ml-1">
                      {pToolName}
                    </span>
                  )}
                </h3>
  
                {!isExpanded && (
                  <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-400 font-mono pr-2 max-w-[200px] truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {normalizedType === 'tool.execution_start' && `args: ${Object.keys(pArguments || {}).join(', ')}`}
                    {normalizedType === 'tool.execution_complete' && (pResultType === 'success' ? 'success' : 'failed')}
                    {normalizedType === 'permission.requested' && `file: ${pFileName}`}
                    {normalizedType === 'assistant.reasoning' && `"${pThought?.slice(0, 30)}..."`}
                    {normalizedType === 'session.error' && `err: ${pError}`}
                    {normalizedType === 'gate.start' && `gate: ${(event.sessionEvent.data as any)?.gateName}`}
                    {normalizedType === 'gate.result' && `pass: ${(event.sessionEvent.data as any)?.pass ? 'true' : 'false'}`}
                  </div>
                )}
              </div>
  
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <span className="font-mono text-[9px] text-slate-400 dark:text-slate-600 opacity-0 group-hover:opacity-100">{timestampStr}</span>
                <button
                  id={`btn-expand-card-${event.sessionEvent.id}`}
                  onClick={(e) => toggleExpand(event.sessionEvent.id, e)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800/80 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
                >
                  <ChevronDown size={14} className={`transform transition-transform duration-200 ${isExpanded ? 'rotate-180' : '-rotate-90'}`} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="px-5 pb-3 pt-1 flex flex-col gap-3">
                
                {((normalizedType !== 'assistant.message' && normalizedType !== 'user.message') || event.isBundle) && (
                  <div className="flex items-center justify-between border-b border-slate-200/50 dark:border-slate-800 pb-2">
                    <div className="flex gap-4">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setTab(event.sessionEvent.id, 'details');
                        }}
                        className={`text-[10px] font-mono tracking-wider transition-colors hover:text-indigo-500 uppercase ${innerTab === 'details' ? 'text-indigo-500 font-bold' : 'text-slate-500'}`}
                      >
                        Details
                      </button>
                      
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setTab(event.sessionEvent.id, 'json');
                        }}
                        className={`text-[10px] font-mono tracking-wider transition-colors hover:text-indigo-500 uppercase ${innerTab === 'json' ? 'text-indigo-500 font-bold' : 'text-slate-500'}`}
                      >
                        JSON
                      </button>
                    </div>

                    <button
                      id={`copy-json-short-${event.sessionEvent.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(JSON.stringify(event, null, 2), `evt-short-${event.sessionEvent.id}`);
                      }}
                      className="text-xs text-slate-500 hover:text-slate-900 transition-all flex items-center gap-1 cursor-pointer"
                    >
                      {copiedText === `evt-short-${event.sessionEvent.id}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                      <span>{copiedText === `evt-short-${event.sessionEvent.id}` ? 'Copied' : 'JSON'}</span>
                    </button>
                  </div>
                )}

                {innerTab === 'details' ? (
                  <div className="text-sm">
                    {(normalizedType as any) === 'composer.plan_mutated' && (
                      <div className="flex flex-col gap-3 mt-1.5 p-4 bg-amber-50/50 dark:bg-amber-950/10 border-amber-300 dark:border-amber-900 rounded-xl border-2 text-left text-xs shadow-md">
                        <div className="flex items-center gap-2">
                           <Sparkles size={16} className="text-amber-500 animate-pulse" />
                           <span className="font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                             Mid-Flight Blueprint Healed (Cycle {eventData.cycle || 5})
                           </span>
                        </div>
                        
                        <p className="text-[11px] text-slate-600 dark:text-slate-400">
                          A persistent pipeline bottleneck was detected. The runtime environment has dynamically mutated the workspace blueprint to inject/modify mandatory verification gates and clear the blocker.
                        </p>

                        <div className="space-y-2 pt-2 border-t border-amber-100 dark:border-amber-900/50">
                          <div className="text-[10px] uppercase font-bold text-amber-700 dark:text-amber-400 tracking-wider">Mutated Gateway Pipeline</div>
                          <div className="flex flex-wrap gap-2">
                            {(eventData.gates || eventData.newGates || []).map((gate: string) => (
                              <div key={gate} className="px-2 py-1 bg-white/90 dark:bg-black/55 border border-amber-200 dark:border-amber-800/80 rounded font-mono text-[10px] text-amber-700 dark:text-amber-400 font-bold shadow-xs">
                                {gate}
                              </div>
                            ))}
                            {(!(eventData.gates || eventData.newGates) || (eventData.gates || eventData.newGates).length === 0) && (
                              <div className="text-slate-400 italic">No gates remaining.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {(normalizedType as any) === 'loop.clarity_check_failed' && (
                      <div className="flex flex-col gap-3 mt-1.5 p-4 bg-rose-50/50 dark:bg-rose-950/10 border-rose-300 dark:border-rose-900 rounded-xl border-2 text-left text-xs shadow-md">
                        <div className="flex items-center gap-2">
                           <ShieldAlert size={16} className="text-rose-500" />
                           <span className="font-bold text-rose-800 dark:text-rose-300 flex items-center gap-1.5">
                             Ambiguity Block Applied (Clarity Score: {eventData.score})
                           </span>
                        </div>
                        
                        <p className="text-[11px] text-slate-600 dark:text-slate-400">
                          The autonomous pipeline has halted because the project goal contains critical ambiguities. Please address the following variables to proceed:
                        </p>

                        <div className="space-y-2 pt-2 border-t border-rose-100 dark:border-rose-900/50">
                          <div className="text-[10px] uppercase font-bold text-rose-700 dark:text-rose-400 tracking-wider">Goal Ambiguity Ledger</div>
                          <div className="flex flex-col gap-2">
                            {(eventData.missingVariables || []).map((v: string) => (
                              <div key={v} className="flex items-start gap-2 p-2 bg-white/90 dark:bg-black/55 border border-rose-250 dark:border-rose-800/80 rounded shadow-xs">
                                <input type="checkbox" className="mt-0.5 rounded border-rose-300 text-rose-600 focus:ring-rose-500" />
                                <span className="text-[11px] text-rose-800 dark:text-rose-300 font-medium">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        
                        <div className="mt-2 text-[10px] text-rose-500 font-semibold italic">
                          Action Required: Refine your request to resolve these check-items.
                        </div>
                      </div>
                    )}

                    {(normalizedType as any) === 'composer.plan' && (
                      <div className="flex flex-col gap-3 mt-1.5 p-4 bg-indigo-50/50 dark:bg-indigo-950/10 border-indigo-200 dark:border-indigo-900 rounded-xl border text-left text-xs">
                        <div className="flex items-center gap-2">
                           <ClipboardList size={16} className="text-indigo-500" />
                           <span className="font-bold text-indigo-800 dark:text-indigo-300">
                             Composer Blueprint: {eventData.taskType?.toUpperCase() || 'GENERAL FEATURE'}
                           </span>
                        </div>
                        
                        <div className="space-y-2">
                          <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Operational Pipeline</div>
                          <div className="flex flex-wrap gap-2">
                            {(eventData.gates || eventData.resolvedGates || []).map((gate: string) => (
                              <div key={gate} className="px-2 py-1 bg-white/80 dark:bg-black/40 border border-slate-200 dark:border-slate-800 rounded font-mono text-[10px] text-indigo-600 dark:text-indigo-400 font-bold">
                                {gate}
                              </div>
                            ))}
                            {(!(eventData.gates || eventData.resolvedGates) || (eventData.gates || eventData.resolvedGates).length === 0) && (
                              <div className="text-slate-400 italic">No gates resolved.</div>
                            )}
                          </div>
                        </div>

                        {eventData.targetDirectories?.length > 0 && (
                          <div className="space-y-1 mt-1 pt-2 border-t border-indigo-100 dark:border-indigo-900/50">
                            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Target Context</div>
                            <div className="text-slate-600 dark:text-slate-400 font-mono text-[10px]">
                              {eventData.targetDirectories.join(', ')}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {(normalizedType as any) === 'loop.complete' && (
                      <div className={`flex flex-col gap-2 mt-1.5 p-3.5 ${pResultType === 'failure' ? 'bg-rose-50/50 dark:bg-rose-950/10 border-rose-200 dark:border-rose-900' : 'bg-emerald-50/50 dark:bg-emerald-950/10 border-emerald-200 dark:border-emerald-900'} rounded-xl border text-left text-xs`}>
                        <div className="flex items-center gap-2">
                           {pResultType === 'failure' ? <XCircle size={15} className="text-rose-500" /> : <CheckCircle2 size={15} className="text-emerald-500" />}
                           <span className={`font-bold ${pResultType === 'failure' ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'}`}>
                             {pSummary}
                           </span>
                        </div>
                        {pError && (
                          <div className="bg-white/50 dark:bg-black/20 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-[11px] font-mono whitespace-pre-wrap mt-1 text-rose-700 dark:text-rose-400">
                             {pError}
                          </div>
                        )}
                        <div className="text-[10px] text-slate-500 font-mono mt-1 font-semibold leading-relaxed">
                          {pDetails}
                        </div>
                        {pExecutionMs && (
                          <div className="text-[10px] text-slate-400 font-mono font-bold pt-1 border-t border-slate-200/50 dark:border-slate-800/50 mt-1">
                            ⏱️ Pipeline End-to-End Latency: {pExecutionMs}ms
                          </div>
                        )}
                      </div>
                    )}

                    {(normalizedType as any) === 'gate.result' && (
                      <div className="flex flex-col gap-2 mt-1.5 p-3.5 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800/80 text-left">
                        <div className="flex items-center gap-3 text-xs">
                          <div className={`flex items-center gap-1.5 font-bold ${eventData.pass ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {eventData.pass ? <CheckCircle2 size={15} className="text-emerald-500" /> : <XCircle size={15} className="text-rose-500" />}
                            {eventData.pass ? 'Passed' : 'Failed'}
                          </div>
                          {eventData.durationMs !== undefined && (
                            <span className="text-xs text-slate-500 font-mono">⏱️ {eventData.durationMs}ms</span>
                          )}
                          <span className="text-xs text-slate-400 ml-auto font-mono">Attempt Retry: {eventData.retryCount ?? 0}</span>
                        </div>
                        {eventData.feedback && (
                          <div className="bg-slate-100 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-150 dark:border-slate-850 text-xs font-mono break-all whitespace-pre-wrap max-h-[160px] overflow-y-auto mt-1 text-slate-700 dark:text-slate-350">
                            <span className="text-[10px] text-slate-400 font-bold block mb-1">STDOUT / STDERR VALVES</span>
                            {eventData.feedback}
                          </div>
                        )}
                      </div>
                    )}

                    {(normalizedType as any) === 'loop.retry' && (
                      <div className="flex flex-col gap-2 mt-1.5 p-3.5 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800/80 text-left text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-amber-800 dark:text-amber-400">Retry Initiated:</span>
                          <span className="font-mono bg-amber-50 dark:bg-amber-950 border border-amber-200/55 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full font-bold">
                            Attempt {eventData.retryCount} of {eventData.maxRetries}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 font-mono text-[11px] bg-slate-100 dark:bg-slate-950 p-2 rounded-lg border border-slate-200 dark:border-slate-850 mt-1 text-slate-600 dark:text-slate-300">
                          <span className="text-slate-400">Current model:</span>
                          <span className="bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 rounded select-all">{eventData.currentModel}</span>
                          <span className="text-slate-400">→ Next:</span>
                          <span className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-250/30 px-1.5 py-0.5 rounded text-emerald-700 dark:text-emerald-400 font-bold select-all">{eventData.nextModel}</span>
                        </div>
                        {eventData.failedGate && (
                          <div className="text-[11px] text-slate-550 dark:text-slate-400 pt-0.5">
                            Failed Gate: <code className="bg-rose-50 dark:bg-rose-950/20 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded font-mono font-bold text-[10px] border border-rose-100 dark:border-rose-900/40">{eventData.failedGate}</code>
                          </div>
                        )}
                        {eventData.feedback && (
                          <div className="bg-slate-100 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-150 dark:border-slate-850 text-[11px] font-mono whitespace-pre-wrap max-h-[120px] overflow-y-auto mt-1 text-slate-600 dark:text-slate-400">
                            <span className="text-[10px] text-slate-400 font-bold block mb-1">FAILED VALVE LOGS</span>
                            {eventData.feedback}
                          </div>
                        )}
                      </div>
                    )}

                    {(normalizedType as any) === 'loop.escalate_human' && (
                      <div className="mt-3 p-4 bg-amber-50/50 dark:bg-amber-950/10 border border-amber-250/70 dark:border-amber-900/60 rounded-xl space-y-3 text-left">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-200">Loop Escalated — Operator Intervention Required</p>
                        </div>
                        <p className="text-[11px] text-slate-650 dark:text-slate-400 leading-normal">
                          {eventData.summary || 'All automated validation retries have been exhausted. Please review the failed gate details and provide corrective directions below to resume the execution pipeline.'}
                        </p>
                        
                        {eventData.failedGate && (
                          <p className="text-[11px] text-slate-500 font-mono">
                            Blamed Gate: <strong className="text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-950 px-1.5 py-0.5 rounded bg-rose-50/40 dark:bg-rose-950/20">{eventData.failedGate}</strong>
                          </p>
                        )}

                        <div className="flex flex-col gap-1.5 mt-2">
                          <span className="text-[10px] text-slate-400 font-bold uppercase font-mono">Operator Correction Guidance</span>
                          <textarea
                            id={`textarea-feedback-${event.sessionEvent.id}`}
                            className="w-full p-2.5 text-xs border border-slate-250 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
                            placeholder="e.g., 'Address the compiler warning by updating the import statements', or 'Fix the linter error in App.tsx line 42...'"
                            onChange={(e) => (event as any).humanInput = e.target.value}
                          />
                        </div>

                        {submitError && (
                          <div className="text-[11px] text-rose-600 dark:text-rose-400 bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/50 p-2.5 rounded-lg font-medium">
                            Failed to resume: {submitError}. Please review and try again.
                          </div>
                        )}

                        <button
                          id={`btn-resume-${event.sessionEvent.id}`}
                          disabled={isSubmitting}
                          className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center justify-center gap-2 ${
                            isSubmitting
                              ? 'bg-amber-300 dark:bg-amber-800/80 text-amber-900 dark:text-amber-200 cursor-not-allowed opacity-80'
                              : 'bg-amber-500 hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-700 text-white cursor-pointer'
                          }`}
                          onClick={() => {
                            const input = (event as any).humanInput || '';                
                            if (resumeAsHuman) {
                              setIsSubmitting(true);
                              setSubmitError(undefined);
                              Promise.resolve(resumeAsHuman(input))
                                .then(() => {
                                  setIsSubmitting(false);
                                })
                                .catch((err) => {
                                  setSubmitError(err.message || String(err));
                                  setIsSubmitting(false);
                                });
                            }
                          }}
                        >
                          {isSubmitting && (
                            <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          )}
                          <span>{isSubmitting ? 'Resuming...' : submitError ? 'Retry Resuming' : 'Resume Pipelines'}</span>
                        </button>
                      </div>
                    )}

                    {normalizedType === 'assistant.message' && (
                      <div className="flex gap-3 items-start mt-1">
                        <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500 shrink-0 shadow-2xs mt-0.5">
                          <Sparkles size={15} />
                        </div>
                        <div className="bg-zinc-50 dark:bg-zinc-900/30 border border-zinc-200 dark:border-zinc-800/80 p-3.5 rounded-2xl rounded-tl-none text-zinc-800 dark:text-zinc-100 max-w-full overflow-hidden grow text-left font-sans">
                          <Markdown content={pText || ''} />
                        </div>
                      </div>
                    )}

                    {normalizedType === 'user.message' && (
                      <div className="flex gap-3 items-start justify-end mt-1">
                        <div className="bg-zinc-100 dark:bg-zinc-850 p-3.5 rounded-2xl rounded-tr-none max-w-full grow md:max-w-2xl text-left border border-zinc-200 dark:border-zinc-750/90 shadow-2xs font-sans text-zinc-800 dark:text-zinc-150">
                          <div className="text-sm font-normal leading-relaxed select-text whitespace-pre-wrap font-sans">
                            {pPrompt}
                          </div>
                          
                          {pAttachments && pAttachments.length > 0 && (
                            <div className="mt-3 pt-2.5 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center gap-2">
                              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase font-bold tracking-wider mr-1 font-mono">Attachments:</span>
                              {pAttachments.map((unknownFile: unknown, fIdx: number) => {
                                const file = unknownFile && typeof unknownFile === 'object' ? (unknownFile as Record<string, unknown>) : {};
                                return (
                                  <div key={fIdx} className="flex items-center gap-1 bg-zinc-200/60 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-350 rounded px-2 py-0.5 text-xs font-mono">
                                    <FolderOpen size={11} />
                                    <span>{String(file.displayName || file.path || file.name || unknownFile)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-zinc-500 dark:text-zinc-400 shrink-0 shadow-2xs mt-0.5">
                          <User size={15} />
                        </div>
                      </div>
                    )}

                    {normalizedType === 'session.start' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border border-slate-200 dark:border-slate-800 rounded-xl p-4 bg-white dark:bg-slate-950 shadow-xs">
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase text-slate-400 font-mono tracking-wider text-left">Session Context Initialization</h4>
                          <div className="text-xs space-y-2 text-left">
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">Session ID:</span><span className="font-mono font-semibold text-slate-800 dark:text-indigo-300">{pSessionId}</span></div>
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">WorkingDirectory:</span><code className="bg-slate-50 dark:bg-slate-800 px-1 py-0.2 rounded text-slate-700 dark:text-slate-300 font-mono text-[11px]">{pWorkingDirectory}</code></div>
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">Client Module:</span><span className="font-sans font-semibold text-slate-800 dark:text-slate-300">{pClientName || 'VSCode Ext'}</span></div>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase text-slate-400 font-mono tracking-wider text-left">Active AI Engine Model</h4>
                          <div className="text-xs space-y-2 text-left">
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">Telemetry Routing:</span><code className="text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/80 font-mono font-bold px-1.5 py-0.2 rounded">{pModel || 'gemini-1.5-pro'}</code></div>
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">Active Sandbox:</span><span className="font-sans font-semibold text-slate-800 dark:text-slate-300 capitalize">{pClientMode || 'Active (GCP Containers)'}</span></div>
                            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-900"><span className="text-slate-400 font-mono">Rules Configured:</span><span className="font-sans font-semibold text-indigo-600 dark:text-indigo-400">Initialized ({pSysSections} sections)</span></div>
                          </div>
                        </div>
                      </div>
                    )}

                    {normalizedType === 'tool.execution_start' && (
                      <div className="flex flex-col gap-1 text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                        <div className="text-[10px] text-slate-500 font-mono">
                          ID: {pToolCallId}
                        </div>
                        <pre className="text-[11px] text-slate-600 dark:text-slate-400 font-mono text-left whitespace-pre-wrap">
                          {JSON.stringify(pArguments, null, 2)}
                        </pre>
                      </div>
                    )}

                    {normalizedType === 'tool.execution_complete' && (
                      <div className="flex flex-col gap-1 text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                        <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                          <span>status: {pResultType}</span>
                          {pExecutionMs && <span>time: {pExecutionMs}ms</span>}
                        </div>

                        {pError && (
                          <div className="text-rose-500 text-[11px] font-mono whitespace-pre-wrap">
                            {pError}
                          </div>
                        )}

                        {pTextResult && (
                          <pre className="text-[11px] text-slate-600 dark:text-slate-400 font-mono whitespace-pre-wrap leading-relaxed">
                            {pTextResult}
                          </pre>
                        )}

                        {binaryItems && binaryItems.length > 0 && binaryItems[0] && (
                          <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-3 bg-white dark:bg-slate-900 mt-2 space-y-2 text-left">
                            <div className="text-xs font-semibold text-slate-707 dark:text-slate-300 flex items-center gap-1.5">
                              <span>Multi-Media Asset Inline Renderer</span>
                              {binaryItems[0].mimeType && (
                                <span className="text-[10px] bg-indigo-50 dark:bg-indigo-950/60 text-indigo-650 dark:text-indigo-400 rounded px-1.5 py-0.2">{binaryItems[0].mimeType}</span>
                              )}
                            </div>
                            {binaryItems[0].description && (
                              <p className="text-xs text-slate-500 italic">{binaryItems[0].description}</p>
                            )}
                            
                            {binaryItems[0].data && binaryItems[0].data !== 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' ? (
                              <div className="mt-2 text-center rounded-lg border border-slate-200 dark:border-slate-800 p-2 bg-slate-50 dark:bg-slate-950 flex justify-center items-center overflow-auto max-h-[300px]">
                                <img 
                                  id={`binary-img-${event.sessionEvent.id}`}
                                  src={
                                    binaryItems[0].data.startsWith('data:') 
                                      ? binaryItems[0].data 
                                      : `data:${binaryItems[0].mimeType || 'image/png'};base64,${binaryItems[0].data}`
                                  } 
                                  alt={binaryItems[0].description || 'Decoded binary telemetry asset'} 
                                  className="max-h-[250px] object-contain rounded-md shadow-xs"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                            ) : (
                              <div className="relative h-44 bg-slate-950 rounded-lg flex flex-col justify-between p-3 overflow-hidden text-slate-100 select-none">
                                <div className="flex justify-between items-center z-10 border-b border-slate-800 pb-1">
                                  <span className="text-[10px] font-mono text-slate-404">MEMORY ALLOCATION PROFILE (RSS)</span>
                                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 rounded font-mono font-bold">STABLE AT 124MB</span>
                                </div>
                                
                                <div className="absolute inset-0 top-10 flex items-center justify-center opacity-70">
                                  <svg className="w-full h-24 stroke-emerald-500 stroke-2 fill-emerald-500/10" viewBox="0 0 100 20">
                                    <path d="M 0 15 Q 15 12, 30 18 T 60 5 T 90 10 L 100 10 L 100 20 L 0 20 Z" />
                                    <path d="M 0 15 Q 15 12, 30 18 T 60 5 T 90 10" fill="none" strokeWidth={1} strokeDasharray="1,2" />
                                  </svg>
                                </div>

                                <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 pt-1 z-10 border-t border-slate-800">
                                  <span>TIME: 0s</span>
                                  <span>LIMIT: 256MB</span>
                                  <span>TIME: 120s</span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {normalizedType === 'assistant.reasoning' && (
                      <div className="space-y-1.5 text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 whitespace-pre-wrap select-text">
                          {pThought}
                        </p>
                        <div className="flex gap-4 text-[9px] text-slate-400 font-mono">
                          <span>effort: {pEffort || 'medium'}</span>
                          {pExecutionMs && <span>time: {pExecutionMs}ms</span>}
                        </div>
                      </div>
                    )}

                    {normalizedType === 'permission.requested' && (
                      <div className="space-y-2 text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                        <div className="flex gap-2 items-center text-[10px] text-slate-500 font-mono">
                          <span>file: {pFileName || 'untitled'}</span>
                          <span>|</span>
                          <span className="uppercase">{pKind || 'Edit'}</span>
                        </div>
                        <pre className="text-[11px] text-slate-600 dark:text-slate-400 font-mono text-left whitespace-pre-wrap">
                          {pDiff || 'No proposal contents.'}
                        </pre>
                      </div>
                    )}

                    {normalizedType === 'permission.completed' && (
                      <div className="flex items-center gap-2 text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                        <span className="text-[10px] text-slate-500 font-mono">
                          decision: <span className="font-bold">{pDecision || 'Approved'}</span>
                        </span>
                        {pComments && (
                          <span className="text-[10px] text-slate-400 italic"> - {pComments}</span>
                        )}
                      </div>
                    )}

                    {normalizedType === 'session.error' && (
                      <div className="text-left pl-2 border-l-2 border-rose-500 dark:border-rose-400">
                        <div className="text-[10px] text-rose-500 font-mono font-bold">
                          Error: {pError || 'Session anomaly'}
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono whitespace-pre-wrap">{pDetails || 'No stacktrace available.'}</p>
                      </div>
                    )}

                    {normalizedType === 'session.shutdown' && (
                      <div className="text-left pl-2 border-l-2 border-slate-200 dark:border-slate-800 text-[11px] font-mono">
                        <div className="text-slate-500">
                          shutdown_code: <span className="font-bold">{pReason || 'Completed'}</span>
                        </div>
                        <div className="text-slate-600 dark:text-slate-400 mt-1 whitespace-pre-wrap">
                          {pSummary || 'Run finalized successfully.'}
                        </div>
                      </div>
                    )}

                    {!['user.message', 'assistant.message', 'assistant.reasoning', 'tool.execution_start', 'tool.execution_complete', 'permission.requested', 'permission.completed', 'session.error', 'session.start', 'session.shutdown', 'turn.start', 'subtask.start', 'subtask.complete', 'TURN_COMPLETED', 'gate.start', 'gate.result', 'loop.complete'].includes(normalizedType) && (
                      <div className="pl-2 border-l-2 border-slate-200 dark:border-slate-800 space-y-2">
                        <div className="text-[10px] uppercase text-zinc-500 font-mono tracking-wider font-semibold">Event Payload</div>
                        <div className="text-xs leading-normal font-mono">
                          {Object.entries(event.sessionEvent.data || {}).map(([key, val]) => (
                            <div key={key} className="flex gap-2 text-left">
                              <span className="text-[10px] text-slate-400 font-bold">{key}:</span>
                              <span className="text-slate-600 dark:text-slate-400 break-all whitespace-pre-wrap">
                                {typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)}
                              </span>
                            </div>
                          ))}
                          {Object.keys(event.sessionEvent.data || {}).length === 0 && (
                            <span className="text-slate-400 italic text-[10px] text-left">No additional payload data.</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="pl-2 border-l-2 border-slate-200 dark:border-slate-800 max-h-[300px] overflow-auto text-left">
                    <pre className="text-[10px] text-slate-500 font-mono whitespace-pre leading-relaxed text-left">
                      {JSON.stringify(event, null, 2)}
                    </pre>
                  </div>
                )}

              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

    </motion.div>
  );
}
