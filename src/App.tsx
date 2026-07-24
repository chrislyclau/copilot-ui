/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';
import { AmbientStatusStrip } from './components/simulator/AmbientStatusStrip';
import { AgentWorkspace } from './components/AgentWorkspace';
import { Timeline } from './components/timeline/Timeline';
import { SessionStats } from './components/inspector/SessionStats';
import { JsonInspector } from './components/inspector/JsonInspector';
import { DiagnosticsModal } from './components/DiagnosticsModal';
import { useScenarios } from './hooks/useScenarios';
import { useClipboard } from './hooks/useClipboard';
import { useGateLoop } from './hooks/useGateLoop';
import LogsModal from './components/LogsModal';

export default function App() {
  // Scenario datasets manager
  const {
    scenarios,
    activeScenarioId,
    setActiveScenarioId,
    currentScenario,
    bundledEvents,
    addScenario,
    appendEventToScenario,
    setScenarioEvents,
    setScenarioTurns,
  } = useScenarios();

  React.useEffect(() => {
    window.__addScenario = addScenario as (scenario: unknown) => void;
  }, [addScenario]);

  // Unified gate-loop orchestration hook
  const {
    runWithGates,
    isRunning: isGateLoopRunning,
    currentTier,
    retryCount,
    activeGate,
    awaitingHuman,
    resumeAsHuman,
    getClientLog,
    activeOutput,
    activeReplayTraceId,
  } = useGateLoop(appendEventToScenario, setScenarioEvents, setScenarioTurns);

  // Search filters & category selection state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Debouncing search queries
  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Unified clipboard utilities
  const { copiedText, copyToClipboard } = useClipboard();
  
  // Focused event ID state lifted from Timeline
  const [focusedEventId, setFocusedEventId] = useState<string | undefined>(undefined);

  // Filtered Events based on search queries and active selection
  const filteredEvents = useMemo(() => {
    return bundledEvents.filter(evt => {
      // Category filter
      if (selectedCategory !== 'all' && evt.category !== selectedCategory) {
        return false;
      }
      
      // Text search
      if (debouncedSearchQuery.trim() === '') return true;
      
      const query = debouncedSearchQuery.toLowerCase();
      const matchTitle = evt.title.toLowerCase().includes(query);
      const matchType = evt.sessionEvent.type.toLowerCase().includes(query);
      const matchCategory = evt.category.toLowerCase().includes(query);
      
      let matchPayload = false;
      try {
        const payloadString = JSON.stringify(evt.sessionEvent).toLowerCase();
        matchPayload = payloadString.includes(query);
      } catch (err) {}

      return matchTitle || matchType || matchCategory || matchPayload;
    });
  }, [bundledEvents, selectedCategory, debouncedSearchQuery]);

  // Layout UI states
  const [isDiagnosticsModalOpen, setIsDiagnosticsModalOpen] = useState(false);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [logs, setLogs] = useState('');

  // Currently focused event for inspection pane
  const activeFocusEvent = useMemo(() => {
    return bundledEvents.find(e => e.sessionEvent.id === focusedEventId) || undefined;
  }, [bundledEvents, focusedEventId]);

  // Fetch active server debugging logs
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      const data = await res.text();
      setLogs(data);
      setIsLogsModalOpen(true);
    } catch (e) {
      console.error('Failed to fetch server debug logs', e);
    }
  };

  // Live download anchor generator
  const downloadActiveSession = () => {
    try {
      const exportData = currentScenario.events; 
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `events-template-${currentScenario.id}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (e) {
      console.error('Failed to export session template', e);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#131314] flex flex-col font-sans transition-colors duration-200">
      
      {/* Dynamic Header */}
      <Header
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        setActiveScenarioId={setActiveScenarioId}
        fetchLogs={fetchLogs}
        activeReplayTraceId={activeReplayTraceId}
      />

      {/* Main interactive cockpit */}
      <main className="w-full mx-auto px-1 py-1 flex-1 flex flex-col lg:flex-row gap-1 items-stretch overflow-hidden">
        
        {/* Left Column: Verification Frame */}
        <section className="flex-[3] flex flex-col gap-1 min-w-0">
          <AmbientStatusStrip
            isRunning={isGateLoopRunning}
            currentTier={currentTier}
            retryCount={retryCount}
            activeGate={activeGate}
            awaitingHuman={awaitingHuman}
            activeOutput={activeOutput}
          />
          <AgentWorkspace 
            runWithGates={runWithGates} 
            isGateLoopRunning={isGateLoopRunning} 
            activeScenarioId={activeScenarioId} 
          />
        </section>

        {/* Right Column: Turn History Sidebar */}
        <aside className="flex-[2] shrink-0 flex flex-col gap-1 min-w-0 bg-white dark:bg-zinc-900/30 rounded-2xl border border-zinc-200 dark:border-zinc-800/80 shadow-xs p-4 overflow-hidden">
          <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-800 dark:text-zinc-200 border-b border-zinc-100 dark:border-zinc-800/80 pb-3 mb-2 flex items-center justify-between">
            Turn History
          </h2>
          <div className="flex-1 overflow-y-auto w-full">
            <Timeline
              activeScenarioId={activeScenarioId}
              bundledEvents={bundledEvents}
              filteredEvents={filteredEvents}
              turnsData={currentScenario.turns}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              copiedText={copiedText}
              copyToClipboard={copyToClipboard}
              onFocusedEventIdChange={setFocusedEventId}
              resumeAsHuman={resumeAsHuman}
              isGateLoopRunning={isGateLoopRunning}
            />
          </div>
        </aside>

      </main>

      {/* Footer bar */}
      <Footer
        setIsDiagnosticsModalOpen={setIsDiagnosticsModalOpen}
      />

      {/* Modals & diagnostic popups */}
      <LogsModal isOpen={isLogsModalOpen} onClose={() => setIsLogsModalOpen(false)} logs={logs} />
      <DiagnosticsModal 
        isOpen={isDiagnosticsModalOpen} 
        onClose={() => setIsDiagnosticsModalOpen(false)} 
        getClientLog={getClientLog}
        runWithGates={runWithGates}
        activeScenarioId={activeScenarioId}
        setActiveScenarioId={setActiveScenarioId}
        setScenarioTurns={setScenarioTurns}
      />

    </div>
  );
}
