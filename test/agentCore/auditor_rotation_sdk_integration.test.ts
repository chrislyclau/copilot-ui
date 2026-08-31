import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from '../harness/CapiProxy';
import { executeAuditSession, ToolDefinition } from '../../src/agentCore/auditorHelper';
import { selectRotatingAuditorConfig } from '../../src/agentCore/auditorHelper';

// Exercises the Issue 79 auditor rotation pool AND the Issue #180 diagnostic
// logging (sendAndWaitWithAbort's tool.execution_start / usage-telemetry
// logs) against a REAL CopilotClient/CopilotSession talking to the CapiProxy
// harness described in docs/copilot-sdk-record-replay.md, rather than the
// hand-mocked session.on()/sendAndWait() doubles used elsewhere in this
// suite. Nothing here asserts against an assumed SDK event shape -- the
// events are whatever the real SDK actually emits when it processes a real
// tool call, so this catches drift between our assumptions (in
// toolCallEnforcement.ts) and the SDK's real contract that a fully mocked
// session/client can't.
describe('Auditor rotation pool against real SDK/proxy transport (Issue 79 + Issue #180)', () => {
  let proxy: CapiProxy;
  let proxyUrl: string;
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rotation-sdk-'));
  const systemPrompt = 'You are an auditor. Report findings via the tool.';
  const userPrompt = 'Audit this change for security issues.';
  const tool: ToolDefinition = {
    function: {
      name: 'submit_finding',
      description: 'Submit an audit finding',
      parameters: {
        type: 'object',
        properties: { pass: { type: 'boolean' } },
        required: ['pass'],
      },
    },
  };

  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    proxy = new CapiProxy();
    proxyUrl = await proxy.start();
    process.env.COPILOT_API_URL = proxyUrl;
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

    const snapshotPath = path.resolve(
      process.cwd(),
      'test/snapshots/gate_loop/auditor_rotation_immediate_tool_call.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });
  }, 30000);

  afterAll(async () => {
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  }, 30000);

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    proxy.requestHistory.length = 0;
    delete process.env.AUDITOR_POOL;
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    logSpy = vi.spyOn(console, 'log');
    errorSpy = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('sends the rotated pool model in the real outgoing request, not just in the local ExecutionConfig', { timeout: 30000 }, async () => {
    // rotationIndex 0 -> first pool entry, per the deterministic round-robin.
    const rotation0 = selectRotatingAuditorConfig(0, 'test-key');
    expect(rotation0.executionConfig.model).toBe('gemini-3.1-flash-lite');

    const result = await executeAuditSession(
      tmpWorkDir,
      rotation0.executionConfig,
      systemPrompt,
      tool,
      userPrompt,
      {},
      undefined,
      30000,
      undefined,
      0
    );

    expect(result).toBeTruthy();

    const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
    expect(completions.length).toBeGreaterThanOrEqual(1);
    // The rotated model must actually be the model field on the real HTTP
    // request sent to CAPI -- not just something selectRotatingAuditorConfig
    // returned locally without it ever reaching the wire.
    expect(completions[0].model).toBe('gemini-3.1-flash-lite');
  });

  it('rotating to the second pool entry sends the second model on the wire', { timeout: 30000 }, async () => {
    const rotation1 = selectRotatingAuditorConfig(1, 'test-key');
    expect(rotation1.executionConfig.model).toBe('gemini-3.5-flash');

    await executeAuditSession(
      tmpWorkDir,
      rotation1.executionConfig,
      systemPrompt,
      tool,
      userPrompt,
      {},
      undefined,
      30000,
      undefined,
      0
    );

    const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(completions[0].model).toBe('gemini-3.5-flash');
  });

  it('logs the real tool.execution_start event emitted by the SDK when the audit tool actually runs', { timeout: 30000 }, async () => {
    const rotation0 = selectRotatingAuditorConfig(0, 'test-key');

    await executeAuditSession(
      tmpWorkDir,
      rotation0.executionConfig,
      systemPrompt,
      tool,
      userPrompt,
      {},
      undefined,
      30000,
      undefined,
      0
    );

    // This is the real SDK's own event, not a hand-mocked one -- confirms
    // the toolName field name/shape assumption in sendAndWaitWithAbort
    // actually matches what the SDK emits in practice.
    const toolUsedLog = logSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('tool used: submit_finding'));
    expect(toolUsedLog).toBeDefined();

    // No "UNEXPECTED EVENT SHAPE" loud-failure should have fired against a
    // real, well-formed SDK event stream.
    const shapeErrors = errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('UNEXPECTED EVENT SHAPE'));
    expect(shapeErrors).toHaveLength(0);
  });
});
