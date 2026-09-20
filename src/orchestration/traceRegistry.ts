import fs from 'fs';
import path from 'path';

export interface TraceEntry {
  turnIndex: number;
  subtaskId: string;
  role: string;
  expectedOutput: string;
}

const TRACE_DIR = path.join(process.cwd(), 'src/test/fixtures/traces');

/**
 * Loads trace profiles from JSON trace files inside src/test/fixtures/traces/
 */
export function loadTraceProfile(traceId: string): TraceEntry[] {
  // Built-in backup for known traces to prevent any file-access failures or template state issues
  const fallbackTraces: Record<string, TraceEntry[]> = {
    'token_bucket_v6_trace': [
      {
        turnIndex: 0,
        subtaskId: 'classify_intent',
        role: 'planner',
        expectedOutput: 'Intent Classified: Token Bucket Rate Limiter validation run. Initiating verification gates.'
      },
      {
        turnIndex: 0,
        subtaskId: 'run_tests',
        role: 'executor',
        expectedOutput: 'Token Bucket Rate Limiter active validation run. Starting automated verify-gate runner.'
      }
    ]
  };

  try {
    if (!fs.existsSync(TRACE_DIR)) {
      fs.mkdirSync(TRACE_DIR, { recursive: true });
    }
  } catch (err) {}

  const filePath = path.join(TRACE_DIR, `${traceId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data as TraceEntry[];
      }
    } catch (err) {
      console.error(`[TraceRegistry] Failed to parse trace file ${traceId}.json:`, err);
    }
  }

  // Fallback to built-in if exists
  if (fallbackTraces[traceId]) {
    return fallbackTraces[traceId]!;
  }

  throw new Error(`Trace profile '${traceId}' not found in registry and has no fallback.`);
}

/**
 * Stub LLM generation interceptor to fetch response content during replay mode
 */
export function fetchStubbedTraceResponse(traceId: string, subtaskId: string, role: string = 'executor', turnIndex: number = 0): string {
  const entries = loadTraceProfile(traceId);
  const matched = entries.find(
    e => e.subtaskId === subtaskId && e.role === role && e.turnIndex === turnIndex
  );

  if (!matched) {
    throw new Error(
      `HARD_ALIGNMENT_DRIFT: Drift detected from the recorded trace sequence for trace '${traceId}'. Expected matching entry for subtask '${subtaskId}', role '${role}', turnIndex ${turnIndex}, but none was found.`
    );
  }

  return matched.expectedOutput;
}
