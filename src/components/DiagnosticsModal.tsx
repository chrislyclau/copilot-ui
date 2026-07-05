import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Play, RefreshCw, CheckCircle2, AlertTriangle, Terminal, Cpu, HardDrive, ShieldCheck, HelpCircle, Copy, FileText } from 'lucide-react';
import { Scenario, CopilotEvent, TurnData } from '../mockEvents';
import { GateConfig } from '../types';

interface DiagnosticsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly getClientLog?: () => readonly string[];
  readonly runWithGates?: (config: GateConfig) => Promise<void>;
  readonly activeScenarioId?: string;
  readonly setActiveScenarioId?: (id: string) => void;
  readonly setScenarioTurns?: (scenarioId: string, turns: readonly TurnData[], events: ReadonlyArray<CopilotEvent>) => void;
}

interface GateDiagResult {
  runWithTimeout: { pass: boolean; durationMs: number };
  runTests: { pass: boolean; durationMs: number; output?: string };
  runLint: { pass: boolean; durationMs: number; output?: string };
}

interface DockerDiagResult {
  pass: boolean;
  durationMs: number;
  stdout?: string;
  exitCode?: number;
}

interface CopilotEventRecord {
  readonly type?: string;
  readonly timestamp?: string;
  readonly data?: {
    readonly content?: string;
    readonly [key: string]: unknown;
  };
}

export function DiagnosticsModal({ 
  isOpen, 
  onClose, 
  getClientLog,
  runWithGates,
  activeScenarioId,
  setActiveScenarioId,
  setScenarioTurns
}: DiagnosticsModalProps) {
  // Gate Diagnostics State
  const [gatesRunning, setGatesRunning] = useState(false);
  const [gatesResult, setGatesResult] = useState<GateDiagResult | undefined>(undefined);
  const [gatesError, setGatesError] = useState<string | undefined>(undefined);

  // CLI Diagnostic Script State
  const [cliScriptRunning, setCliScriptRunning] = useState(false);
  const [cliScriptResult, setCliScriptResult] = useState<{ pass: boolean; durationMs: number; output?: string; errorOutput?: string; } | undefined>(undefined);
  const [cliScriptError, setCliScriptError] = useState<string | undefined>(undefined);

  // Run Log Dump State
  const [dumpedLogs, setDumpedLogs] = useState<{ server: readonly string[], client: readonly string[] } | undefined>(undefined);
  const [dumpLogsRunning, setDumpLogsRunning] = useState(false);

  // Docker Diagnostics State
  const [dockerRunning, setDockerRunning] = useState(false);
  const [dockerResult, setDockerResult] = useState<DockerDiagResult | undefined>(undefined);
  const [dockerError, setDockerError] = useState<string | undefined>(undefined);

  // SSE Smoke Test State
  const [sseRunning, setSseRunning] = useState(false);
  const [sseEvents, setSseEvents] = useState<readonly CopilotEventRecord[]>([]);
  const [sseStatus, setSseStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');

  // SDK Connection Test State
  const [sdkRunning, setSdkRunning] = useState(false);
  const [sdkLogs, setSdkLogs] = useState<readonly string[]>([]);
  const [sdkAnswer, setSdkAnswer] = useState<string | undefined>(undefined);
  const [sdkConfirm, setSdkConfirm] = useState(false);
  const [sdkError, setSdkError] = useState<string | undefined>(undefined);

  // T5 - Live Copilot SSE Stream Test
  const [t5Running, setT5Running] = useState(false);
  const [t5Events, setT5Events] = useState<readonly CopilotEventRecord[]>([]);
  const [t5Prompt, setT5Prompt] = useState("Write a quick sum function in typescript and trigger standard checks using npx tsx.");
  const [t5Error, setT5Error] = useState<string | undefined>(undefined);
  const [t5Model, setT5Model] = useState("gemini-3.1-flash-lite");
  const [t5Key, setT5Key] = useState("");
  const [t5Confirm, setT5Confirm] = useState(false);

  // T6 - Gate-Run Scenario Test (Manual Test replication)
  const [t6Running, setT6Running] = useState(false);
  const [t6Events, setT6Events] = useState<readonly CopilotEventRecord[]>([]);
  const [t6Prompt, setT6Prompt] = useState("Run diagnostic checks");
  const [t6Error, setT6Error] = useState<string | undefined>(undefined);
  const [t6Scenario, setT6Scenario] = useState("replay");
  const [t6Model, setT6Model] = useState("gemini-3.1-flash-lite");
  const [t6Confirm, setT6Confirm] = useState(false);
  const [t6ReplayTraceId, setT6ReplayTraceId] = useState("token_bucket_v6_trace");
  const [customTraceId, setCustomTraceId] = useState("");
  const [backpressureDelay, setBackpressureDelay] = useState(0);

  // T7 - Proxy Dump State
  const [proxyRunning, setProxyRunning] = useState(false);
  const [proxyLog, setProxyLog] = useState<string | undefined>(undefined);
  const [proxyError, setProxyError] = useState<string | undefined>(undefined);

  // Handlers
  const handleCheckGates = async () => {
    setGatesRunning(true);
    setGatesError(undefined);
    try {
      const res = await fetch('/api/diagnostics/gates?type=ENVIRONMENT_INTEGRITY_CHECK');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setGatesResult(data);
    } catch (err: unknown) {
      setGatesError(err instanceof Error ? err.message : String(err));
    } finally {
      setGatesRunning(false);
    }
  };

  const handleCheckCliScript = async () => {
    setCliScriptRunning(true);
    setCliScriptError(undefined);
    try {
      const res = await fetch('/api/diagnostics/cli-gate-script');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setCliScriptResult({
        pass: data.success,
        durationMs: data.durationMs,
        output: data.output,
        errorOutput: data.errorOutput
      });
    } catch (err: unknown) {
      setCliScriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setCliScriptRunning(false);
    }
  };

  const runBackendSanityTest = async () => {
    setDockerRunning(true);
    setDockerError(undefined);
    try {
      const res = await fetch('/api/diagnostics/docker?type=ENVIRONMENT_INTEGRITY_CHECK');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setDockerResult(data);
    } catch (err: unknown) {
      setDockerError(err instanceof Error ? err.message : String(err));
    } finally {
      setDockerRunning(false);
    }
  };

  const handleSseSmokeTest = () => {
    setSseRunning(true);
    setSseEvents([]);
    setSseStatus('running');

    const source = new EventSource('/api/diagnostics/sse-smoke');

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as CopilotEventRecord;
        setSseEvents((prev) => [...prev, parsed]);
        
        // If we get look.complete or session.idle, update state
        if (parsed.type === 'loop.complete') {
          setSseStatus('completed');
        }
      } catch (err) {
        console.error('SSE JSON parse error:', err);
      }
    };

    source.onerror = (err) => {
      console.warn('SSE ended or error encountered:', err);
      source.close();
      setSseRunning(false);
      setSseStatus((prev) => (prev === 'completed' ? 'completed' : 'failed'));
    };
  };

  const handleCheckSdk = async () => {
    setSdkConfirm(false);
    setSdkRunning(true);
    setSdkError(undefined);
    setSdkLogs([]);
    setSdkAnswer(undefined);

    try {
      const res = await fetch('/api/copilot/test');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setSdkLogs(data.logs || []);
      if (data.success) {
        setSdkAnswer(data.answer);
      } else {
        setSdkError(data.error || 'Unknown integration error');
      }
    } catch (err: unknown) {
      setSdkError(err instanceof Error ? err.message : String(err));
    } finally {
      setSdkRunning(false);
    }
  };

  const handleCheckT5 = async () => {
    setT5Confirm(false);
    setT5Running(true);
    setT5Error(undefined);
    setT5Events([]);

    try {
      const response = await fetch('/api/copilot/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: t5Prompt,
          apiKey: t5Key || undefined,
          model: t5Model,
          sessionId: `diag-${Math.random().toString(36).substring(7)}`,
          cwd: '.'
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      if (!response.body) {
        throw new Error('Response body is undefined or not readable');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as CopilotEventRecord;
              setT5Events((prev) => [...prev, data]);
            } catch (pErr) {
              console.warn('T5 JSON parse error:', pErr);
            }
          }
        }
      }
    } catch (err: unknown) {
      setT5Error(err instanceof Error ? err.message : String(err));
    } finally {
      setT5Running(false);
    }
  };

  const handleCheckT6 = async () => {
    setT6Confirm(false);
    setT6Running(true);
    setT6Error(undefined);
    setT6Events([]);

    try {
      const isReplay = t6Scenario === 'replay';
      const traceToUse = isReplay && t6ReplayTraceId === 'custom' ? customTraceId : t6ReplayTraceId;
      const response = await fetch('/api/copilot/gate-run?stream=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: t6Prompt,
          gates: ['tests', 'lint'] as const,
          maxRetries: 2,
          apiKey: 'dummy',
          model: t6Model,
          cwd: '/workspace',
          sessionId: `diag-scenario-${Math.random().toString(36).substring(7)}`,
          diagnosticScenario: isReplay ? undefined : t6Scenario,
          replayTraceId: isReplay ? traceToUse : undefined,
          simulateBackpressureDelayMs: isReplay && backpressureDelay > 0 ? backpressureDelay : undefined
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      const resJson = await response.json();
      const currentSessionId = resJson.sessionId;

      const streamResponse = await fetch(`/api/copilot/gate-stream?sessionId=${currentSessionId}`, {
        method: 'GET'
      });

      if (!streamResponse.ok) {
        throw new Error(`HTTP error ${streamResponse.status}: ${await streamResponse.text()}`);
      }

      if (!streamResponse.body) {
        throw new Error('Response body is undefined or not readable');
      }

      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as CopilotEventRecord;
              setT6Events((prev) => [...prev, data]);
            } catch (pErr) {
              console.warn('T6 JSON parse error:', pErr);
            }
          }
        }
      }
    } catch (err: unknown) {
      setT6Error(err instanceof Error ? err.message : String(err));
    } finally {
      setT6Running(false);
    }
  };

  const handleTriggerMainAppReplay = async () => {
    if (!runWithGates) {
      setT6Error("The main application run handler is not available.");
      return;
    }
    setT6Confirm(false);
    setT6Error(undefined);
    onClose(); // Close the diagnostics modal
    try {
      const traceToUse = t6ReplayTraceId === 'custom' ? customTraceId : t6ReplayTraceId;
      
      const newScenarioId = `replay-sim-${Date.now()}`;
      const newScenario: Scenario = {
        id: newScenarioId,
        name: `[Replay] ${t6Prompt.substring(0, 15)}...`,
        description: `Diagnostic Replay Trace: ${traceToUse}`,
        icon: 'Play',
        events: []
      };
      
      if (typeof window.__addScenario === 'function') {
         window.__addScenario(newScenario);
      }
      if (setActiveScenarioId) {
        setActiveScenarioId(newScenarioId);
      }

      await runWithGates({
        prompt: t6Prompt,
        gates: ['tests', 'lint'] as const,
        maxRetries: 2,
        sessionId: newScenarioId,
        model: t6Model,
        apiKey: 'dummy_key',
        cwd: '.',
        replayTraceId: traceToUse,
        simulateBackpressureDelayMs: backpressureDelay > 0 ? backpressureDelay : undefined,
        setScenarioTurns
      });
    } catch (err: unknown) {
      console.error("Failed to run main app replay:", err);
      setT6Error(err instanceof Error ? err.message : 'Failed to start replay');
    }
  };

  const handleDumpLogs = async () => {
    setDumpLogsRunning(true);
    try {
      const res = await fetch('/api/diagnostics/last-run-log');
      const data = await res.json();
      const serverLog: readonly string[] = data.serverLog || [];
      const clientLog: readonly string[] = getClientLog ? getClientLog() : [];
      setDumpedLogs({ server: serverLog, client: clientLog });
      
      const copyText = `--- SERVER LOG ---\n${serverLog.join('\n')}\n\n--- CLIENT LOG ---\n${clientLog.join('\n')}`;
      navigator.clipboard.writeText(copyText).catch(() => {});
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setDumpLogsRunning(false);
    }
  };

  const handleDumpProxy = async () => {
    setProxyRunning(true);
    setProxyError(undefined);
    try {
      const res = await fetch('/api/diagnostics/proxy-log');
      const data = await res.json();
      
      if (!data.success) throw new Error(data.error || 'Failed to fetch proxy logs');
      setProxyLog(data.log || '');
      
      navigator.clipboard.writeText(data.log || '').catch(() => {});
    } catch (err: unknown) {
      setProxyError(err instanceof Error ? err.message : String(err));
    } finally {
      setProxyRunning(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="diag-modal-wrapper"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
          {/* Backdrop */}
          <div
            onClick={onClose}
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
          />

          {/* Modal Container */}
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 15 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 15 }}
            transition={{ type: 'spring', duration: 0.3 }}
            className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto relative z-10 flex flex-col"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-violet-50 dark:bg-violet-900 flex items-center justify-center text-violet-600 dark:text-violet-400">
                  <ShieldCheck size={18} />
                </div>
                <div className="text-left">
                  <h3 className="font-bold text-slate-900 dark:text-white text-base">Workspace Sandbox Diagnostics Suite</h3>
                  <p className="text-xs text-slate-500">Validate local gate scripts, Docker environment stability, SSE loops, and authentic SDK connections.</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Content Body */}
            <div className="p-6 space-y-6 overflow-y-auto text-left grow">
              
              {/* T0 - Run Log Dump */}
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <FileText size={14} className="text-indigo-500" />
                    <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T0: Internal Pipeline Run Logs</span>
                  </div>
                  <button
                    onClick={handleDumpLogs}
                    disabled={dumpLogsRunning}
                    className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50 hover:bg-indigo-150 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-bold font-mono text-[11px] rounded-lg border border-indigo-100 dark:border-indigo-900 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    <Copy size={11} />
                    <span>Dump & Copy Run Log</span>
                  </button>
                </div>

                {dumpedLogs && (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold">Server Subprocess Log buffer (Latest {dumpedLogs.server.length} entries)</div>
                      <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800 max-h-[160px] overflow-y-auto font-mono text-[10px] text-slate-700 dark:text-slate-300">
                        {dumpedLogs.server.length > 0 ? dumpedLogs.server.map((l, i) => <div key={i}>{l}</div>) : "Empty server log."}
                      </div>
                    </div>
                    
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold">Client Hook Log buffer (Latest {dumpedLogs.client.length} entries)</div>
                      <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800 max-h-[160px] overflow-y-auto font-mono text-[10px] text-slate-700 dark:text-slate-300">
                        {dumpedLogs.client.length > 0 ? dumpedLogs.client.map((l, i) => <div key={i}>{l}</div>) : "Empty client log."}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* T1 - Gate Diagnostics */}
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <Cpu size={14} className="text-indigo-500" />
                    <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T1: Verification Gates</span>
                  </div>
                  <button
                    id="btn-check-gates"
                    onClick={handleCheckGates}
                    disabled={gatesRunning}
                    className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50 hover:bg-indigo-150 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-bold font-mono text-[11px] rounded-lg border border-indigo-100 dark:border-indigo-900 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    {gatesRunning ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} />}
                    <span>Check Gates</span>
                  </button>
                </div>

                {gatesError && (
                  <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                    Failed to run gates: {gatesError}
                  </div>
                )}

                {gatesResult && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs font-mono">
                    <div className="p-2 bg-white dark:bg-slate-900 rounded-lg border dark:border-slate-800">
                      <div className="flex items-center justify-between font-bold mb-1">
                        <span>runWithTimeout</span>
                        {gatesResult.runWithTimeout.pass ? (
                          <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 size={12} /> PASS</span>
                        ) : (
                          <span className="text-red-500 flex items-center gap-0.5"><AlertTriangle size={12} /> FAIL</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500">Duration: {gatesResult.runWithTimeout.durationMs}ms</div>
                    </div>

                    <div className="p-2 bg-white dark:bg-slate-900 rounded-lg border dark:border-slate-800">
                      <div className="flex items-center justify-between font-bold mb-1">
                        <span>runTests</span>
                        {gatesResult.runTests.pass ? (
                          <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 size={12} /> PASS</span>
                        ) : (
                          <span className="text-red-500 flex items-center gap-0.5"><AlertTriangle size={12} /> FAIL</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500">Duration: {gatesResult.runTests.durationMs}ms</div>
                      <div className="text-[9px] text-slate-400 mt-1 truncate" title={gatesResult.runTests.output}>
                        Output: {gatesResult.runTests.output || "Empty"}
                      </div>
                    </div>

                    <div className="p-2 bg-white dark:bg-slate-900 rounded-lg border dark:border-slate-800">
                      <div className="flex items-center justify-between font-bold mb-1">
                        <span>runLint</span>
                        {gatesResult.runLint.pass ? (
                          <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 size={12} /> PASS</span>
                        ) : (
                          <span className="text-red-500 flex items-center gap-0.5"><AlertTriangle size={12} /> FAIL</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500">Duration: {gatesResult.runLint.durationMs}ms</div>
                      <div className="text-[9px] text-slate-400 mt-1 truncate" title={gatesResult.runLint.output}>
                        Output: {gatesResult.runLint.output || "Empty"}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* T1.5 - CLI Gate Script */}
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <Terminal size={14} className="text-pink-500" />
                    <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T1.5: CLI Gate Script (npm run diagnose:gates)</span>
                  </div>
                  <button
                    id="btn-check-cli-script"
                    onClick={handleCheckCliScript}
                    disabled={cliScriptRunning}
                    className="flex items-center gap-1.5 px-3 py-1 bg-pink-50 hover:bg-pink-150 dark:bg-pink-950/50 dark:hover:bg-pink-900/60 text-pink-700 dark:text-pink-300 font-bold font-mono text-[11px] rounded-lg border border-pink-100 dark:border-pink-900 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    {cliScriptRunning ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} />}
                    <span>Run Script</span>
                  </button>
                </div>

                {cliScriptError && (
                  <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                    Failed to run CLI script: {cliScriptError}
                  </div>
                )}

                {cliScriptResult && (
                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex items-center gap-2">
                       <span className="font-bold">Script Execution Status:</span>
                       {cliScriptResult.pass ? (
                         <span className="text-emerald-500 font-bold flex items-center gap-0.5"><CheckCircle2 size={12} /> COMPLETED SUCCESSFULLY</span>
                       ) : (
                         <span className="text-red-500 font-bold flex items-center gap-0.5"><AlertTriangle size={12} /> SCRIPT FAILED (Non-zero exit code)</span>
                       )}
                       <span className="text-[10px] text-slate-400">({cliScriptResult.durationMs}ms duration)</span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">Standard Output</div>
                        <pre className="text-[10px] text-slate-700 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap leading-tight max-h-[160px]">
                          {cliScriptResult.output || "No stdout."}
                        </pre>
                      </div>
                      <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">Standard Error</div>
                        <pre className="text-[10px] text-red-700 dark:text-red-400 overflow-x-auto whitespace-pre-wrap leading-tight max-h-[160px]">
                          {cliScriptResult.errorOutput || "No stderr."}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* T2 - Backend Sandbox Diagnostics */}
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <HardDrive size={14} className="text-indigo-500" />
                    <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T2: Backend Sandbox Environment</span>
                  </div>
                  <button
                    id="btn-check-docker"
                    onClick={runBackendSanityTest}
                    disabled={dockerRunning}
                    className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50 hover:bg-indigo-150 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-bold font-mono text-[11px] rounded-lg border border-indigo-100 dark:border-indigo-900 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    {dockerRunning ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} />}
                    <span>Check Sandbox</span>
                  </button>
                </div>

                {dockerError && (
                  <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                    Failed to run sandbox process: {dockerError}
                  </div>
                )}

                {dockerResult && (
                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">Sandbox Connectivity:</span>
                      {dockerResult.pass ? (
                        <span className="text-emerald-500 font-bold flex items-center gap-0.5"><CheckCircle2 size={12} /> ESTABLISHED</span>
                      ) : (
                        <>
                          <span className="text-red-500 font-bold flex items-center gap-0.5"><AlertTriangle size={12} /> FAILED / SKIPPED</span>
                          <div className="mt-2 p-2 bg-yellow-50 dark:bg-yellow-950/20 text-yellow-800 dark:text-yellow-300 rounded-lg flex items-start gap-2 border border-yellow-200 dark:border-yellow-900">
                             <span>Sandbox offline or unreachable. The runner will silently transition execution workflows dynamically in diagnostic scenarios at the server level.</span>
                          </div>
                        </>
                      )}
                      
                      <span className="text-[10px] text-slate-400">({dockerResult.durationMs}ms duration)</span>
                    </div>

                    <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">Sandbox Environment Probe Output</div>
                      <pre className="text-[10px] text-slate-700 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap leading-tight max-h-[80px]">
                        {dockerResult.stdout || "No stdout. Exit code " + dockerResult.exitCode}
                      </pre>
                    </div>
                  </div>
                )}
              </div>

              {/* T3 - SSE Smoke Test */}
              <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <Terminal size={14} className="text-indigo-500" />
                    <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T3: SSE Simulator Smoke Test</span>
                  </div>
                  <button
                    id="btn-smoke-sse"
                    onClick={handleSseSmokeTest}
                    disabled={sseRunning}
                    className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50 hover:bg-indigo-150 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-bold font-mono text-[11px] rounded-lg border border-indigo-100 dark:border-indigo-900 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    {sseRunning ? <RefreshCw size={11} className="animate-spin animate-infinite" /> : <Play size={11} />}
                    <span>Smoke Test SSE</span>
                  </button>
                </div>

                <div className="space-y-2 text-xs font-mono">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-bold">Reader Loop Status:</span>
                    {sseStatus === 'idle' && <span className="text-slate-500 uppercase">Idle</span>}
                    {sseStatus === 'running' && <span className="text-indigo-500 animate-pulse uppercase">Active Streaming</span>}
                    {sseStatus === 'completed' && <span className="text-emerald-500 font-bold flex items-center gap-0.5"><CheckCircle2 size={12} /> COMPLETE (SUCCESS)</span>}
                    {sseStatus === 'failed' && <span className="text-red-500 font-bold flex items-center gap-0.5"><AlertTriangle size={12} /> FAILED</span>}
                  </div>

                  {sseEvents.length > 0 && (
                    <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800 space-y-1">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">Parsed SSE Buffer Stream</div>
                      <div className="max-h-[120px] overflow-y-auto space-y-1 text-[10px] divider-y divider-slate-100">
                        {sseEvents.map((ev, idx) => (
                          <div key={idx} className="text-slate-600 dark:text-slate-400 flex justify-between">
                            <span>➔ {ev.type}</span>
                            <span className="text-slate-400 font-light truncate max-w-[250px]">{JSON.stringify(ev)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* T6 - Gate-Run Diagnostic Scenario Stream Tester */}
                <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <Terminal size={14} className="text-indigo-500" />
                      <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T6: Diagnostic Gate-Run Sandbox Test (/api/copilot/gate-run)</span>
                    </div>

                    {!t6Confirm && !t6Running ? (
                      <div className="flex items-center gap-2">
                        <button
                          id="btn-t6-trigger-app"
                          onClick={handleTriggerMainAppReplay}
                          className="flex items-center gap-1.5 px-3 py-1 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900 dark:hover:bg-emerald-800 text-emerald-700 dark:text-emerald-300 font-bold font-mono text-[11px] rounded-lg border border-emerald-100 dark:border-emerald-900 cursor-pointer transition-all"
                        >
                          <Play size={11} className="text-emerald-500" />
                          <span>Run in Main Cockpit</span>
                        </button>
                        <button
                          id="btn-t6-trigger"
                          onClick={() => setT6Confirm(true)}
                          className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900 dark:hover:bg-indigo-800 text-indigo-700 dark:text-indigo-300 font-bold font-mono text-[11px] rounded-lg border border-indigo-100 dark:border-indigo-900 cursor-pointer transition-all"
                        >
                          <Play size={11} />
                          <span>Run Scenario Test (Terminal)</span>
                        </button>
                      </div>
                    ) : t6Confirm ? (
                      <div className="flex items-center gap-1.5 font-mono text-[11px]">
                        <span className="text-indigo-600 dark:text-indigo-400 font-semibold uppercase animate-pulse">Execute diagnostic scenario?</span>
                        <button
                          id="btn-t6-yes"
                          onClick={handleCheckT6}
                          className="px-2 py-0.5 bg-indigo-600 text-white rounded cursor-pointer font-bold hover:bg-indigo-700 transition-colors"
                        >
                          Run
                        </button>
                        <button
                          id="btn-t6-no"
                          onClick={() => setT6Confirm(false)}
                          className="px-2 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded cursor-pointer hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                        <RefreshCw size={11} className="animate-spin" />
                        <span>Streaming scenario events...</span>
                      </div>
                    )}
                  </div>

                  {/* Inputs */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Simulated Query</label>
                      <textarea
                        value={t6Prompt}
                        onChange={(e) => setT6Prompt(e.target.value)}
                        disabled={t6Running}
                        rows={2}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 font-mono text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
                        placeholder="Enter query..."
                      />
                    </div>

                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Scenario</label>
                          <select
                            value={t6Scenario}
                            onChange={(e) => setT6Scenario(e.target.value)}
                            disabled={t6Running}
                            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1.5 font-mono text-xs focus:ring-1 focus:ring-indigo-500 outline-none cursor-pointer"
                          >
                            <option value="clean_run">Clean Run (Pass First Time)</option>
                            <option value="single_retry">Single Retry (Fail {"->"} Pass)</option>
                            <option value="model_escalation">Tier Upgrade (Fail 2x {"->"} Upgrade {"->"} Pass)</option>
                            <option value="human_escalation">Human Review (Fail All Tiers)</option>
                            <option value="gate_crash">Infrastructure Crash (Exception)</option>
                            <option value="replay">Shadow Replay Mode</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Model</label>
                          <select
                            value={t6Model}
                            onChange={(e) => setT6Model(e.target.value)}
                            disabled={t6Running}
                            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1.5 font-mono text-xs focus:ring-1 focus:ring-indigo-500 outline-none cursor-pointer"
                          >
                            <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                            
                          </select>
                        </div>
                      </div>

                      {t6Scenario === 'replay' && (
                        <div className="space-y-2 p-2 bg-indigo-50/50 dark:bg-indigo-950/10 rounded-lg border border-indigo-100/50 dark:border-indigo-900/30 animate-in fade-in slide-in-from-top-1 duration-200 text-left">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[9.5px] uppercase font-bold text-indigo-700 dark:text-indigo-400 font-mono mb-1">Trace Profile</label>
                              <select
                                value={t6ReplayTraceId}
                                onChange={(e) => setT6ReplayTraceId(e.target.value)}
                                disabled={t6Running}
                                className="w-full bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900 rounded-lg p-1 font-mono text-[11px] outline-none cursor-pointer text-indigo-900 dark:text-indigo-200"
                              >
                                <option value="token_bucket_v6_trace">Trace: Token Bucket Rate Limiter Validation Run</option>
                                <option value="custom">Custom Replay Trace ID...</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[9.5px] uppercase font-bold text-indigo-700 dark:text-indigo-400 font-mono mb-1">Backpressure (ms)</label>
                              <input
                                type="number"
                                min="0"
                                max="5000"
                                value={backpressureDelay}
                                onChange={(e) => setBackpressureDelay(Math.max(0, parseInt(e.target.value) || 0))}
                                disabled={t6Running}
                                className="w-full bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900 rounded-lg p-1 font-mono text-[11px] outline-none text-indigo-900 dark:text-indigo-200"
                                placeholder="0"
                              />
                            </div>
                          </div>

                          {t6ReplayTraceId === 'custom' && (
                            <div className="space-y-1 animate-in fade-in duration-150">
                              <label className="block text-[9px] uppercase font-bold text-slate-500 font-mono">Custom Trace Profile ID</label>
                              <input
                                type="text"
                                value={customTraceId}
                                onChange={(e) => setCustomTraceId(e.target.value)}
                                disabled={t6Running}
                                placeholder="e.g. security_denial_v1_trace"
                                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1.5 font-mono text-xs focus:ring-1 focus:ring-indigo-500 outline-none text-indigo-900 dark:text-indigo-200"
                              />
                              <p className="text-[9px] text-slate-500 font-sans leading-tight">Must match a valid trace file named <code>{"{ID}"}.json</code> within the <code>src/test/fixtures/traces/</code> directory.</p>
                            </div>
                          )}
                        </div>
                      )}

                      <p className="text-[10px] text-slate-400">
                        This replicates the exact manual test flow running on `/api/copilot/gate-run`. Built-in sandbox gates like lint and tests will run dynamically.
                      </p>
                    </div>
                  </div>

                  {t6Error && (
                    <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                      Error executing Scenario Stream test: {t6Error}
                    </div>
                  )}

                  {t6Events.length > 0 && (
                    <div className="text-xs font-mono space-y-2">
                      <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                        <div className="flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">
                          <span>Live Streamed Scenario SSE Packets ({t6Events.length})</span>
                          <button
                            onClick={() => setT6Events([])}
                            className="text-[9px] text-blue-500 hover:underline cursor-pointer"
                          >
                            Clear
                          </button>
                        </div>
                        <div className="max-h-[180px] overflow-y-auto space-y-1 text-[9px] text-slate-600 dark:text-slate-400 leading-normal font-mono select-text divide-y divide-slate-100 dark:divide-slate-800">
                          {t6Events.map((evt, idx) => (
                            <div key={idx} className="pt-1.5 pb-1 font-mono">
                              <div className="flex items-center gap-1.5 font-bold mb-0.5">
                                <span className="text-indigo-500">➜ {evt.type || 'unknown'}</span>
                                <span className="text-[8px] text-slate-400 font-light">
                                  {evt.timestamp ? new Date(evt.timestamp).toISOString().split('T')[1]?.slice(0, -1) : ''}
                                </span>
                              </div>
                              {evt.data?.content && (
                                <div className="pl-3 text-slate-800 dark:text-slate-200 border-l border-indigo-100 dark:border-indigo-950 my-1 py-0.5">
                                  {evt.data.content}
                                </div>
                              )}
                              <pre className="text-[8px] text-slate-400 overflow-x-auto select-all whitespace-pre bg-slate-50/50 dark:bg-slate-950/40 p-1 rounded mt-0.5">
                                {JSON.stringify(evt.data || {}, undefined, 1)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
 
               {/* T4 - Copilot SDK Client integration */}
               <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                   <div className="flex items-center gap-2 font-mono text-xs">
                     <Terminal size={14} className="text-rose-500" />
                     <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T4: SDK Integration (Token Consuming)</span>
                   </div>
                   
                   {!sdkConfirm && !sdkRunning ? (
                     <button
                       id="btn-test-sdk-trigger"
                       onClick={() => setSdkConfirm(true)}
                       className="flex items-center gap-1.5 px-3 py-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/20 dark:hover:bg-rose-950/45 text-rose-700 dark:text-rose-300 font-bold font-mono text-[11px] rounded-lg border border-rose-100 dark:border-rose-900 cursor-pointer transition-all"
                     >
                       <Play size={11} />
                       <span>Test SDK Client</span>
                     </button>
                   ) : sdkConfirm ? (
                     <div className="flex items-center gap-1.5 font-mono text-[11px]">
                       <span className="text-rose-600 font-semibold uppercase animate-pulse">Are you sure? Will use real tokens.</span>
                       <button
                         id="btn-test-sdk-yes"
                         onClick={handleCheckSdk}
                         className="px-2 py-0.5 bg-emerald-500 text-white rounded cursor-pointer font-bold hover:bg-emerald-600 transition-colors"
                       >
                         Yes
                       </button>
                       <button
                         id="btn-test-sdk-no"
                         onClick={() => setSdkConfirm(false)}
                         className="px-2 py-0.5 bg-slate-205 dark:bg-slate-800 rounded cursor-pointer text-slate-600 dark:text-slate-350 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                       >
                         Cancel
                       </button>
                     </div>
                   ) : (
                     <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                       <RefreshCw size={11} className="animate-spin" />
                       <span>Sending Test prompt...</span>
                     </div>
                   )}
                 </div>
 
                 {sdkError && (
                   <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                     Failed SDK integration probe: {sdkError}
                   </div>
                 )}
 
                 {(sdkLogs.length > 0 || sdkAnswer) && (
                   <div className="text-xs font-mono space-y-2">
                     {sdkAnswer && (
                       <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/15 border border-emerald-100 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 rounded-lg">
                         <strong className="block uppercase text-[9px] text-emerald-500 font-bold">LSP Subprocess Answer Response</strong>
                         <p className="mt-1 font-semibold">"{sdkAnswer}"</p>
                       </div>
                     )}
                     <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                       <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">Subprocess StdIO Connection Logs</div>
                       <div className="max-h-[140px] overflow-y-auto space-y-0.5 text-[9px] text-slate-500 select-text leading-tight font-mono">
                         {sdkLogs.map((log, idx) => (
                           <div key={idx}>{log}</div>
                         ))}
                       </div>
                     </div>
                   </div>
                 )}
               </div>

               {/* T5 - Interactive Copilot SSE Run */}
               <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                   <div className="flex items-center gap-2 font-mono text-xs">
                     <Terminal size={14} className="text-violet-500" />
                     <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T5: Custom Prompt Stream Tester (/api/copilot/run)</span>
                   </div>

                   {!t5Confirm && !t5Running ? (
                     <button
                       id="btn-t5-trigger"
                       onClick={() => setT5Confirm(true)}
                       className="flex items-center gap-1.5 px-3 py-1 bg-violet-50 hover:bg-violet-100 dark:bg-violet-900 dark:hover:bg-violet-800 text-violet-700 dark:text-violet-300 font-bold font-mono text-[11px] rounded-lg border border-violet-100 dark:border-violet-900 cursor-pointer transition-all"
                     >
                       <Play size={11} />
                       <span>Run Custom Stream Test</span>
                     </button>
                   ) : t5Confirm ? (
                     <div className="flex items-center gap-1.5 font-mono text-[11px]">
                       <span className="text-violet-600 font-semibold uppercase animate-pulse">Run with custom prompt config?</span>
                       <button
                         id="btn-t5-yes"
                         onClick={handleCheckT5}
                         className="px-2 py-0.5 bg-violet-600 text-white rounded cursor-pointer font-bold hover:bg-violet-700 transition-colors"
                       >
                         Run
                       </button>
                       <button
                         id="btn-t5-no"
                         onClick={() => setT5Confirm(false)}
                         className="px-2 py-0.5 bg-slate-205 dark:bg-slate-800 rounded cursor-pointer text-slate-600 dark:text-slate-350 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                       >
                         Cancel
                       </button>
                     </div>
                   ) : (
                     <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                       <RefreshCw size={11} className="animate-spin" />
                       <span>Streaming events...</span>
                     </div>
                   )}
                 </div>

                 {/* Inputs */}
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                   <div className="space-y-1">
                     <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Custom Test Prompt</label>
                     <textarea
                       value={t5Prompt}
                       onChange={(e) => setT5Prompt(e.target.value)}
                       disabled={t5Running}
                       rows={2}
                       className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2 font-mono text-xs focus:ring-1 focus:ring-violet-500 outline-none"
                       placeholder="Enter prompt..."
                     />
                   </div>

                   <div className="space-y-3">
                     <div className="grid grid-cols-2 gap-2">
                       <div>
                         <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Model</label>
                         <select
                           value={t5Model}
                           onChange={(e) => setT5Model(e.target.value)}
                           disabled={t5Running}
                           className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1.5 font-mono text-xs focus:ring-1 focus:ring-violet-500 outline-none"
                         >
                           
                           <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                         </select>
                       </div>
                       <div>
                         <label className="block text-[10px] uppercase font-bold text-slate-500 font-mono">Custom API Key (Optional)</label>
                         <input
                           type="password"
                           value={t5Key}
                           onChange={(e) => setT5Key(e.target.value)}
                           disabled={t5Running}
                           placeholder="BYOK or default env"
                           className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1.5 font-mono text-xs focus:ring-1 focus:ring-violet-500 outline-none"
                         />
                       </div>
                     </div>
                     <p className="text-[10px] text-slate-400">
                       Triggers a full simulation. If sandbox execution tools are requested, they will be auto-approved and run in real-time.
                     </p>
                   </div>
                 </div>

                 {t5Error && (
                   <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                     Error executing Copilot SSE stream test: {t5Error}
                   </div>
                 )}

                 {t5Events.length > 0 && (
                   <div className="text-xs font-mono space-y-2">
                     <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800">
                       <div className="flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-wide font-bold mb-1">
                         <span>Live Streamed SSE Packets ({t5Events.length})</span>
                         <button
                           onClick={() => setT5Events([])}
                           className="text-[9px] text-blue-500 hover:underline cursor-pointer"
                         >
                           Clear
                         </button>
                       </div>
                       <div className="max-h-[180px] overflow-y-auto space-y-1 text-[9px] text-slate-600 dark:text-slate-450 leading-normal font-mono select-text divide-y divide-slate-100 dark:divide-slate-800">
                         {t5Events.map((evt, idx) => (
                           <div key={idx} className="pt-1.5 pb-1 font-mono">
                             <div className="flex items-center gap-1.5 font-bold mb-0.5">
                               <span className="text-violet-500">➜ {evt.type || 'unknown'}</span>
                               <span className="text-[8px] text-slate-400 font-light">
                                 {evt.timestamp ? new Date(evt.timestamp).toISOString().split('T')[1]?.slice(0, -1) : ''}
                               </span>
                             </div>
                             {evt.data?.content && (
                               <div className="pl-3 text-slate-800 dark:text-slate-200 border-l border-violet-100 dark:border-violet-950 my-1 py-0.5">
                                 {evt.data.content}
                               </div>
                             )}
                             <pre className="text-[8px] text-slate-400 overflow-x-auto select-all whitespace-pre bg-slate-50/50 dark:bg-slate-950/40 p-1 rounded mt-0.5">
                               {JSON.stringify(evt.data || {}, undefined, 1)}
                             </pre>
                           </div>
                         ))}
                       </div>
                     </div>
                   </div>
                 )}
               </div>

               {/* T7 - Proxy Interception Logs */}
               <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-100 dark:border-slate-850 space-y-3">
                 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                   <div className="flex items-center gap-2 font-mono text-xs">
                     <FileText size={14} className="text-zinc-500" />
                     <span className="font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">T7: Proxy Interception Logs (Gemini Request Fix)</span>
                   </div>
                   <button
                     onClick={handleDumpProxy}
                     disabled={proxyRunning}
                     className="flex items-center gap-1.5 px-3 py-1 bg-zinc-50 hover:bg-zinc-150 dark:bg-zinc-950/50 dark:hover:bg-zinc-900/60 text-zinc-700 dark:text-zinc-300 font-bold font-mono text-[11px] rounded-lg border border-zinc-100 dark:border-zinc-900 cursor-pointer disabled:opacity-50 transition-all"
                   >
                     {proxyRunning ? <RefreshCw size={11} className="animate-spin" /> : <Copy size={11} />}
                     <span>Fetch & Copy Proxy Log</span>
                   </button>
                 </div>

                 {proxyError && (
                   <div className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono">
                     Failed to load proxy logs: {proxyError}
                   </div>
                 )}

                 {proxyLog && (
                   <div className="space-y-1">
                     <div className="text-[10px] text-slate-500 uppercase tracking-wide font-bold">Latest Proxy Activity (Intercepted requests mapping)</div>
                     <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border dark:border-slate-800 max-h-[160px] overflow-y-auto font-mono text-[10px] whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                       {proxyLog.length > 0 ? proxyLog : "No logs."}
                     </div>
                   </div>
                 )}
               </div>

            </div>

            {/* Footer */}
            <div className="p-4 bg-slate-50 dark:bg-slate-950 flex justify-end gap-2 border-t border-slate-100 dark:border-slate-850 rounded-b-2xl shrink-0">
              <button
                onClick={onClose}
                className="px-3.5 py-1.5 bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 text-xs font-bold rounded-xl cursor-pointer transition-colors"
              >
                Close Diagnostics
              </button>
            </div>

          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
