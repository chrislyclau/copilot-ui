import { useState, useMemo } from 'react';
import { PRESET_SCENARIOS, Scenario, CopilotEvent, TurnData } from '../mockEvents';
import { getBundledEvents } from '../parser';

export function useScenarios() {
  const [scenarios, setScenarios] = useState<readonly Scenario[]>(PRESET_SCENARIOS);
  const [activeScenarioId, setActiveScenarioId] = useState<string>(PRESET_SCENARIOS[0]!.id);

  // Active scenario definition
  const currentScenario: Scenario = useMemo(() => {
    return scenarios.find(s => s.id === activeScenarioId) || scenarios[0]!;
  }, [scenarios, activeScenarioId]);

  // Get bundled events (where consecutive message_delta and streaming_delta are combined)
  const bundledEvents = useMemo(() => {
    return getBundledEvents(currentScenario.events);
  }, [currentScenario.events]);


  const addScenario = (newScenario: Scenario) => {
    setScenarios(prev => [newScenario, ...prev]);
    setActiveScenarioId(newScenario.id);
  };

  const appendEventToScenario = (scenarioId: string, copilotEvent: CopilotEvent) => {
    setScenarios(prev => prev.map((s): Scenario => {
      if (s.id === scenarioId) {
        const exists = s.events.some(e => e.sessionEvent.id === copilotEvent.sessionEvent.id);
        if (exists) return s;
        return {
          ...s,
          events: [...s.events, copilotEvent]
        };
      }
      return s;
    }));
  };

  const setScenarioEvents = (scenarioId: string, events: readonly CopilotEvent[]) => {
    setScenarios(prev => prev.map((s): Scenario => {
      if (s.id === scenarioId) {
        return {
          ...s,
          events
        };
      }
      return s;
    }));
  };

  const setScenarioTurns = (scenarioId: string, turns: readonly TurnData[], events: readonly CopilotEvent[]) => {
    setScenarios(prev => prev.map((s): Scenario => {
      if (s.id === scenarioId) {
        return {
          ...s,
          turns,
          events
        };
      }
      return s;
    }));
  };

  return {
    scenarios,
    setScenarios,
    activeScenarioId,
    setActiveScenarioId,
    currentScenario,
    bundledEvents,

    addScenario,
    appendEventToScenario,
    setScenarioEvents,
    setScenarioTurns
  };
}
