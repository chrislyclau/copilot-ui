import { SessionEvent, ToolExecutionCompleteContent } from './copilotSdk/boundary';

import { ExtendedSessionEvent } from './types/events';

export interface TelemetryUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalNanoAiu: number; // nano-AI Units (nanoAiu)
  creditsCost: number; // Derived: totalNanoAiu * 10E-9
}

export interface CopilotEvent {
  // Pure, unmodified domain model conforming strictly to @github/copilot-sdk SessionEvent structure.
  sessionEvent: ExtendedSessionEvent;

  // View-model visualizer properties cleanly segregated from the SDK models.
  title: string;
  category: 'system' | 'user' | 'assistant' | 'tool' | 'permission' | 'error';
  
  // Optional bundling / timeline streaming metadata, kept orthogonal to the standard event model.
  isBundle?: boolean;
  bundleType?: ExtendedSessionEvent['type'];
  originalEvents?: CopilotEvent[];

  // Optional pre-calculated telemetry metadata to avoid app-level heuristics.
  telemetryUsage?: TelemetryUsage;
}

export interface TurnData {
  id: string;
  taskLabel: string;
  status: 'running' | 'completed' | 'failed';
  events: any[];
  commitSha?: string | null;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  icon: string;
  events: CopilotEvent[]; // Fallback flat events for backward compatibility
  turns?: TurnData[];
}

export const RAW_STANDARD_DEBUG: SessionEvent[] = [
  {
    id: 'pay-001',
    parentId: null,
    timestamp: '2026-06-08T23:56:40.100Z',
    type: 'session.start',
    data: {
      copilotVersion: '1.94.0',
      producer: 'VSCode-CopilotExtension',
      selectedModel: 'claude-3-5-sonnet',
      sessionId: 'copilot-session-a87d-891c',
      startTime: '2026-06-08T23:56:40.100Z',
      version: 1,
      reasoningEffort: 'medium',
      context: {
        cwd: '/workspace/node-express-backend',
        branch: 'main'
      }
    }
  } as any,
  {
    id: 'pay-002',
    parentId: 'pay-001',
    timestamp: '2026-06-08T23:56:42.300Z',
    type: 'user.message',
    data: {
      content: 'Inspect the recent modifications in server.ts. It seems we are getting a route clash or crash on startup when routing to the health endpoint. Help me diagnose and apply a fix, staging it in Git.',
      agentMode: 'autopilot',
      attachments: [
        {
          type: 'file',
          path: './server.ts',
          displayName: 'server.ts'
        }
      ]
    }
  } as any,
  {
    id: 'pay-003',
    parentId: 'pay-002',
    timestamp: '2026-06-08T23:56:43.050Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-01',
      content: "The user complains about a startup crash and health route clash in server.ts. First, let me check the git status or git diff on server.ts to see what was recently edited. I'll invoke the git_diff tool to see what changes exist."
    }
  } as any,
  {
    id: 'pay-004',
    parentId: 'pay-003',
    timestamp: '2026-06-08T23:56:44.020Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_git_diff_01',
      toolName: 'git_diff',
      model: 'claude-3-5-sonnet',
      arguments: {
        filePath: 'server.ts',
        contextLines: 5
      }
    }
  } as any,
  {
    id: 'pay-005',
    parentId: 'pay-004',
    timestamp: '2026-06-08T23:56:44.550Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_git_diff_01',
      success: true,
      toolDescription: {
        name: 'git_diff'
      },
      result: {
        content: `diff --git a/server.ts b/server.ts
index d83f7d1..a9238eb 100644
--- a/server.ts
+++ b/server.ts
@@ -10,13 +10,14 @@ const app = express();
 const PORT = 3000;
 
 // API routes go here FIRST
-app.get("/api/health", (req, res) => {
-  res.json({ status: "ok" });
-});
-
+app.use("/api/*", (req, res, next) => {
+  // Redirect everything
+  res.status(500).send("Access Denied");
+});
+
+app.get("/api/health", (req, res) => {
+  res.json({ status: "ok", uptime: process.uptime() });
+});`
      },
      toolTelemetry: {
        executionTimeMs: 530
      }
    }
  } as any,
  {
    id: 'pay-006',
    parentId: 'pay-005',
    timestamp: '2026-06-08T23:56:45.010Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-02',
      content: 'Looking at the git diff on server.ts, someone added a wildcard router `app.use("/api/*", ...)` *before* the `/api/health` route. In Express, route resolution goes sequentially! The wildcard middleware intercepts `/api/health`, does not call `next()`, and immediately sends a `500 Access Denied` response. This is why `/api/health` returns an error, or crashes if process.uptime is not handled. I need to move `/api/health` ABOVE the blocking wildcard, or rewrite the wildcard middleware to properly check and delegate. I will first propose moving the health check above the wildcard.'
    }
  } as any,
  {
    id: 'pay-007',
    parentId: 'pay-006',
    timestamp: '2026-06-08T23:56:45.500Z',
    type: 'assistant.message',
    data: {
      messageId: 'msg-001',
      content: `### Diagnosis

I have inspected the modifications in \`server.ts\` and found the root cause:

An Express wildcard route has been added **before** the \`/api/health\` endpoint:
\`\`\`typescript
app.use("/api/*", (req, res, next) => {
  res.status(500).send("Access Denied");
});

app.get("/api/health", (req, res) => { ... });
\`\`\`

Because Express routes request handlers sequentially, **any** call to \`/api/health\` first triggers the wildcard middleware, which immediately terminates the connection with a \`500 Access Denied\` instead of passing the request forward.

### Solution

I will fix this layout issue by re-ordering the route declarations:
1. Define the specific \`/api/health\` route **first**.
2. Define the broad wildcard block **last**, or adjust it with safe routing rules.

Let me apply this edit to \`server.ts\` right now.`
    }
  } as any,
  {
    id: 'pay-008',
    parentId: 'pay-007',
    timestamp: '2026-06-08T23:56:46.210Z',
    type: 'permission.requested',
    data: {
      requestId: 'req-01',
      permissionRequest: {
        kind: 'write',
        fileName: 'server.ts',
        intention: 'Modify server.ts to move health check above wildcard route',
        diff: `<<<<
app.use("/api/*", (req, res, next) => {
  // Redirect everything
  res.status(500).send("Access Denied");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});
====
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.use("/api/*", (req, res, next) => {
  // Catch all remaining API routes
  res.status(404).json({ error: "Endpoint not found" });
});
>>>>`,
        canOfferSessionApproval: false
      }
    }
  } as any,
  {
    id: 'pay-009',
    parentId: 'pay-008',
    timestamp: '2026-06-08T23:56:48.400Z',
    type: 'permission.completed',
    data: {
      requestId: 'req-01',
      result: {
        kind: 'approved'
      }
    }
  } as any,
  {
    id: 'pay-010',
    parentId: 'pay-009',
    timestamp: '2026-06-08T23:56:49.010Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_edit_file_02',
      toolName: 'edit_file',
      arguments: {
        filePath: 'server.ts',
        targetChunk: 'app.use("/api/*", ... app.get("/api/health" ...'
      }
    }
  } as any,
  {
    id: 'pay-011',
    parentId: 'pay-010',
    timestamp: '2026-06-08T23:56:49.800Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_edit_file_02',
      success: true,
      toolDescription: {
        name: 'edit_file'
      },
      result: {
        content: 'File server.ts edited successfully. 18 lines updated.'
      }
    }
  } as any,
  {
    id: 'pay-012',
    parentId: 'pay-011',
    timestamp: '2026-06-08T23:56:50.150Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_run_tsc_03',
      toolName: 'run_tsc',
      arguments: {
        project: './tsconfig.json'
      }
    }
  } as any,
  {
    id: 'pay-013',
    parentId: 'pay-012',
    timestamp: '2026-06-08T23:56:51.300Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_run_tsc_03',
      success: false,
      toolDescription: {
        name: 'run_tsc'
      },
      error: {
        message: 'TypeScript compilation failed on server.ts'
      },
      result: {
        content: "server.ts(21,20): error TS2304: Cannot find name 'processs'. Did you mean 'process'?"
      }
    }
  } as any,
  {
    id: 'pay-014',
    parentId: 'pay-013',
    timestamp: '2026-06-08T23:56:51.350Z',
    type: 'session.error',
    data: {
      errorCode: 'TS2304',
      errorType: 'compiler',
      message: "TS2304: Cannot find name 'processs' at server.ts:21",
      stack: 'Compiler found an unresolved identifier "processs" at line 21, likely introduced by manual input or a keyboard bounce.'
    }
  } as any,
  {
    id: 'pay-015',
    parentId: 'pay-014',
    timestamp: '2026-06-08T23:56:52.000Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-03',
      content: 'Ah! In editing the file, there was a minor keyboard slip resulting in "processs.uptime()" instead of "process.uptime()". Let me issue another quick search/replace edit to replace "processs" with "process" to correct the compilation.'
    }
  } as any,
  {
    id: 'pay-016',
    parentId: 'pay-015',
    timestamp: '2026-06-08T23:56:52.200Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_edit_file_04',
      toolName: 'edit_file',
      arguments: {
        filePath: 'server.ts',
        replaceTarget: 'processs.uptime()',
        replaceWith: 'process.uptime()'
      }
    }
  } as any,
  {
    id: 'pay-017',
    parentId: 'pay-016',
    timestamp: '2026-06-08T23:56:52.700Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_edit_file_04',
      success: true,
      toolDescription: {
        name: 'edit_file'
      },
      result: {
        content: 'File server.ts edited successfully. Corrected "processs" -> "process".'
      }
    }
  } as any,
  {
    id: 'pay-018',
    parentId: 'pay-017',
    timestamp: '2026-06-08T23:56:53.000Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_run_tsc_05',
      toolName: 'run_tsc',
      arguments: {
        project: './tsconfig.json'
      }
    }
  } as any,
  {
    id: 'pay-019',
    parentId: 'pay-018',
    timestamp: '2026-06-08T23:56:54.100Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_run_tsc_05',
      success: true,
      toolDescription: {
        name: 'run_tsc'
      },
      result: {
        content: 'TS compilation succeeded with 0 warnings or errors.'
      }
    }
  } as any,
  {
    id: 'pay-020',
    parentId: 'pay-019',
    timestamp: '2026-06-08T23:56:54.600Z',
    type: 'assistant.message',
    data: {
      messageId: 'msg-002',
      content: `### Fix Applied Successfully!

I have updated \`server.ts\` and resolved the route sequence collision. I also caught and resolved a typo where \`processs\` was written instead of the Node.js global \`process\`.

Here is the verified status:
1. **Compilation Status**: ✅ Successfully compiled with zero errors.
2. **Endpoint Layout**: The \`/api/health\` endpoint is now defined **above** the fallback router, allowing successful processing.
3. **Fallback Route**: The wildcard route has been safely set up to catch unknown API requests and return a clean \`404 Endpoint not found\` JSON error instead of standard 500 status.

Everything is compiled and is fully ready. Let me know if you would like me to stage these changes and make a draft commit next!`
    }
  } as any,
  {
    id: 'pay-021',
    parentId: 'pay-020',
    timestamp: '2026-06-08T23:56:55.200Z',
    type: 'session.shutdown',
    data: {
      shutdownType: 'routine',
      sessionStartTime: 1780963000100,
      totalApiDurationMs: 4500,
      modelMetrics: {},
      codeChanges: {
        filesModified: ['server.ts'],
        linesAdded: 5,
        linesRemoved: 3
      }
    }
  } as any
];

export const RAW_SECURITY_DENIAL: SessionEvent[] = [
  {
    id: 'pay-201',
    parentId: null,
    timestamp: '2026-06-09T09:12:00.000Z',
    type: 'session.start',
    data: {
      copilotVersion: '1.94.0',
      producer: 'VSCode-CopilotExtension',
      selectedModel: 'gpt-4o',
      sessionId: 'copilot-sec-992a',
      startTime: '2026-06-09T09:12:00.000Z',
      version: 1,
      reasoningEffort: 'low',
      context: {
        cwd: '/workspace/fintech-payment-portal',
        branch: 'feature/auth'
      }
    }
  } as any,
  {
    id: 'pay-202',
    parentId: 'pay-201',
    timestamp: '2026-06-09T09:12:02.500Z',
    type: 'user.message',
    data: {
      content: 'Let\'s run our database seeding migrations tool and inspect the confidential environment parameters on .env to confirm Stripe details.',
      agentMode: 'interactive'
    }
  } as any,
  {
    id: 'pay-203',
    parentId: 'pay-202',
    timestamp: '2026-06-09T09:12:03.200Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-20',
      content: 'The user wants to read .env to inspect Stripe credentials and execute a DB migration. Reading .env requires reading file keys which could contain secrets. I will issue a permission requested event for file inspection of `.env` to protect security bounds.'
    }
  } as any,
  {
    id: 'pay-204',
    parentId: 'pay-203',
    timestamp: '2026-06-09T09:12:04.100Z',
    type: 'permission.requested',
    data: {
      requestId: 'req-db-01',
      permissionRequest: {
        kind: 'shell',
        intention: 'Verify Stripe configuration keys inside confidential environment parameters',
        fullCommandText: 'cat .env | grep -E "STRIPE_|SECRET_KEY"',
        canOfferSessionApproval: false,
        commands: [{ identifier: 'cat', readOnly: true }],
        hasWriteFileRedirection: false,
        possiblePaths: ['.env'],
        possibleUrls: []
      }
    }
  } as any,
  {
    id: 'pay-205',
    parentId: 'pay-204',
    timestamp: '2026-06-09T09:12:06.800Z',
    type: 'permission.completed',
    data: {
      requestId: 'req-db-01',
      result: {
        kind: 'denied-interactively-by-user'
      }
    }
  } as any,
  {
    id: 'pay-206',
    parentId: 'pay-205',
    timestamp: '2026-06-09T09:12:07.400Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-21',
      content: 'The permission to view Stripe secret variables from `.env` was explicitly rejected by the operator. I must halt secret inspection immediately, acknowledge the security block gracefully, and offer to proceed with non-sensitive migrations instead.'
    }
  } as any,
  {
    id: 'pay-207',
    parentId: 'pay-206',
    timestamp: '2026-06-09T09:12:08.100Z',
    type: 'assistant.message',
    data: {
      messageId: 'msg-201',
      content: `### Security Shield Triggered

The request to inspect sensitive credentials inside \`.env\` was **declined** by the system safety policy rules. Under strict sandbox security protocols, I cannot dump or extract production secrets or keys.

To safeguard your API config:
- **Environment Rules**: Do not dump raw environmental profiles to active UI nodes.
- **Next Steps**: We can still proceed with running database schema migrations.

Please let me know if you want me to initiate db migration scripts independently without reading secret keys!`
    }
  } as any,
  {
    id: 'pay-208',
    parentId: 'pay-207',
    timestamp: '2026-06-09T09:12:09.000Z',
    type: 'session.shutdown',
    data: {
      shutdownType: 'routine',
      sessionStartTime: 1780963000100,
      totalApiDurationMs: 4500,
      modelMetrics: {},
      codeChanges: {
        filesModified: [],
        linesAdded: 0,
        linesRemoved: 0
      }
    }
  } as any
];

export const RAW_LARGE_BINARY_OUTPUTS: SessionEvent[] = [
  {
    id: 'pay-301',
    parentId: null,
    timestamp: '2026-06-09T14:40:00.000Z',
    type: 'session.start',
    data: {
      copilotVersion: '1.94.0',
      producer: 'VSCode-CopilotExtension',
      selectedModel: 'gemini-1.5-pro',
      sessionId: 'copilot-media-88d3',
      startTime: '2026-06-09T14:40:00.000Z',
      version: 1,
      reasoningEffort: 'high',
      context: {
        cwd: '/workspace/fintech-dashboard',
        branch: 'main'
      }
    }
  } as any,
  {
    id: 'pay-302',
    parentId: 'pay-301',
    timestamp: '2026-06-09T14:40:02.100Z',
    type: 'user.message',
    data: {
      content: 'Generate a high-contrast architectural data visualization of our system modules distribution layout.',
      agentMode: 'autopilot'
    }
  } as any,
  {
    id: 'pay-303',
    parentId: 'pay-302',
    timestamp: '2026-06-09T14:40:03.050Z',
    type: 'assistant.reasoning',
    data: {
      reasoningId: 'reasoning-30',
      content: 'The operator requests system architectural mapping. I will trigger the rendering engine utilizing the system visualization tool to output a rich diagnostic diagram layout.'
    }
  } as any,
  {
    id: 'pay-304',
    parentId: 'pay-303',
    timestamp: '2026-06-09T14:40:04.000Z',
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_render_map_01',
      toolName: 'render_system_map',
      model: 'gemini-1.5-pro',
      arguments: {
        dimensions: '800x450',
        highContrast: true,
        palette: 'cool_metal'
      }
    }
  } as any,
  {
    id: 'pay-305',
    parentId: 'pay-304',
    timestamp: '2026-06-09T14:40:04.900Z',
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_render_map_01',
      success: true,
      toolDescription: {
        name: 'render_system_map'
      },
      result: {
        content: 'Architectural model distribution plot plotted securely. Outputs list contain 1 graphical SVG array layer.',
        contents: [
          {
            type: 'image',
            description: 'System modules dependency topology distribution plot',
            mimeType: 'image/svg+xml',
            data: '<svg viewBox="0 0 800 450" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="800" height="450" fill="#0b1329" rx="12"/><g stroke="#1b263b" stroke-width="1.5"><line x1="150" y1="225" x2="350" y2="125"/><line x1="150" y1="225" x2="350" y2="325"/><line x1="350" y1="125" x2="550" y2="225"/><line x1="350" y1="325" x2="550" y2="225"/><line x1="550" y1="225" x2="700" y2="225"/></g><circle cx="150" cy="225" r="30" fill="#4f46e5" stroke="#818cf8" stroke-width="3"/><text x="150" y="230" font-family="monospace" font-size="12" fill="#fff" text-anchor="middle" font-weight="bold">INGRESS</text><circle cx="350" cy="125" r="30" fill="#0891b2" stroke="#22d3ee" stroke-width="3"/><text x="350" y="130" font-family="monospace" font-size="12" fill="#fff" text-anchor="middle" font-weight="bold">ENGINE</text><circle cx="350" cy="325" r="30" fill="#0d9488" stroke="#2dd4bf" stroke-width="3"/><text x="350" y="330" font-family="monospace" font-size="12" fill="#fff" text-anchor="middle" font-weight="bold">CACHE</text><circle cx="550" cy="225" r="30" fill="#db2777" stroke="#f472b6" stroke-width="3"/><text x="550" y="230" font-family="monospace" font-size="12" fill="#fff" text-anchor="middle" font-weight="bold">ANALYTICS</text><circle cx="700" cy="225" r="22" fill="#4b5563" stroke="#9ca3af" stroke-width="2"/><text x="700" y="229" font-family="monospace" font-size="10" fill="#fff" text-anchor="middle" font-weight="bold">STORE</text><g font-family="sans-serif" font-size="10" fill="#94a3b8"><text x="150" y="275" text-anchor="middle">Port 3000 (HTTPS)</text><text x="350" y="75" text-anchor="middle">TS Core Engine</text><text x="350" y="375" text-anchor="middle">Redis Cache Node</text><text x="550" y="275" text-anchor="middle">Clickstream Aggregation</text><text x="700" y="265" text-anchor="middle">PostgreSQL</text></g></svg>'
          } as ToolExecutionCompleteContent
        ]
      },
      toolTelemetry: {
        executionTimeMs: 820
      }
    }
  } as any,
  {
    id: 'pay-306',
    parentId: 'pay-305',
    timestamp: '2026-06-09T14:40:06.000Z',
    type: 'assistant.message',
    data: {
      messageId: 'msg-301',
      content: `### System Topology Rendered

I have completed rendering the multi-modal dependency layout topology plot representing your modules cluster:

- **Ingress Gateway**: Listens securely on Port 3000 mapping upstream.
- **Node Execution Core**: Orchestrates parallel caching via Redis modules.
- **Telemetry Analytics**: Handles async clickstream events down to Postgres.

The graphical asset vector visual is attached directly below in the tool summary trace.`
    }
  } as any,
  {
    id: 'pay-307',
    parentId: 'pay-306',
    timestamp: '2026-06-09T14:40:06.800Z',
    type: 'session.shutdown',
    data: {
      shutdownType: 'routine',
      sessionStartTime: 1780963000100,
      totalApiDurationMs: 4500,
      modelMetrics: {},
      codeChanges: {
        filesModified: [],
        linesAdded: 0,
        linesRemoved: 0
      }
    }
  } as any
];

export function getEventTelemetryUsage(evt: CopilotEvent, baseMultiplier: number = 1.0): TelemetryUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let nanoAiu = 0;

  const sEvt = evt?.sessionEvent || {} as any;
  const sData = sEvt?.data as any;
  const typeStr = sEvt?.type || '';

  switch (typeStr) {
    case 'user.message': {
      const length = sData?.content?.length || 120;
      promptTokens = Math.round(length * 0.45 + 120);
      nanoAiu = promptTokens * 400000;
      break;
    }
    case 'assistant.message': {
      const length = sData?.content?.length || 250;
      completionTokens = Math.round(length * 0.55 + 80);
      nanoAiu = completionTokens * 1500000;
      break;
    }
    case 'assistant.reasoning': {
      const length = sData?.content?.length || 300;
      reasoningTokens = Math.round(length * 0.50 + 150);
      nanoAiu = reasoningTokens * 1200000;
      break;
    }
    case 'tool.execution_start': {
      nanoAiu = 450000000;
      break;
    }
    case 'tool.execution_complete': {
      const dataSize = sData?.result?.content?.length || sData?.error?.message?.length || 100;
      completionTokens = Math.round(dataSize * 0.15 + 50);
      const isBinary = Array.isArray(sData?.result?.contents) && sData.result.contents.some((c: any) => c && typeof c === 'object' && c.type === 'image');
      nanoAiu = isBinary ? 2800000000 : (250000000 + completionTokens * 200000);
      break;
    }
    case 'permission.requested': {
      nanoAiu = 650000000;
      break;
    }
    case 'session.error': {
      nanoAiu = 350000000;
      break;
    }
    default: {
      nanoAiu = 0;
      break;
    }
  }

  const scaledNanoAiu = Math.round(nanoAiu * baseMultiplier);
  const creditsCost = scaledNanoAiu * 1e-9;

  return {
    promptTokens: promptTokens || undefined,
    completionTokens: completionTokens || undefined,
    reasoningTokens: reasoningTokens || undefined,
    totalNanoAiu: scaledNanoAiu,
    creditsCost: parseFloat(creditsCost.toFixed(6))
  };
}

export function deriveCopilotEvents(rawEvents: SessionEvent[]): CopilotEvent[] {
  let prevId: string | null = null;
  return rawEvents.map((evt, index) => {
    const timestamp = evt.timestamp || new Date().toISOString();
    const type = evt.type;
    const id = evt.id || `evt-derived-${index}-${Date.now()}`;
    const parentId = evt.parentId !== undefined ? evt.parentId : prevId;
    prevId = id;

    // Standardize data representation
    const data = evt.data || { content: '' };
    const standardizedEvent = {
      ...evt,
      id,
      parentId,
      timestamp,
      type,
      data
    } as SessionEvent;

    // Derive elegant titles for timeline listing
    let title = `${type}`;
    if (type === 'session.start') title = 'Session Started';
    else if (type === 'user.message') title = 'User Message Received';
    else if (type === 'assistant.reasoning') title = 'Formulating Plan';
    else if (type === 'tool.execution_start') {
      const sData = data as any;
      title = `Tool Call: ${sData?.toolName || 'Unknown Tool'}`;
    } else if (type === 'tool.execution_complete') {
      const sData = data as any;
      const tName = sData?.toolDescription?.name || sData?.toolName || 'Unknown Tool';
      title = `Tool Result: ${tName}`;
    } else if (type === 'permission.requested') title = 'Permission Requested';
    else if (type === 'permission.completed') title = 'Permission Decision';
    else if (type === 'session.error') title = 'Error Occurred';
    else if (type === 'session.shutdown') title = 'Session Concluded';

    let category: 'system' | 'user' | 'assistant' | 'tool' | 'permission' | 'error' = 'system';
    const t = type.toLowerCase();
    if (t.startsWith('user') || t.includes('prompt') || t.includes('query') || t === 'input') {
      category = 'user';
    } else if (t.startsWith('assistant') || t.includes('message') || t.includes('response') || t === 'text') {
      category = 'assistant';
    } else if (t.startsWith('tool') || t.includes('call') || t.includes('invoke')) {
      category = 'tool';
    } else if (t.startsWith('permission') || t.includes('request') || t === 'ask') {
      category = 'permission';
    } else if (t.includes('error') || t.includes('exception') || t.includes('fault')) {
      category = 'error';
    } else {
      category = 'system';
    }

    const copEvt: CopilotEvent = {
      sessionEvent: standardizedEvent,
      title,
      category
    };

    copEvt.telemetryUsage = getEventTelemetryUsage(copEvt);
    return copEvt;
  });
}

// Map RAW presets into scenario lists
export const PRESET_SCENARIOS: Scenario[] = [
  {
    id: 'empty-session',
    name: 'New Session',
    description: 'A clean session history.',
    icon: 'Activity',
    events: []
  }
];
