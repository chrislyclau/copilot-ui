import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app, activeSessions } from '../../server';
import { CapiProxy } from './harness/CapiProxy';

// Mock CapiProxy config only ever reads `workDir` for bookkeeping in these
// tests; it is kept pointed at an isolated OS-tmpdir location rather than
// process.cwd() so nothing here is wired toward the app's own source tree.
const mockProxyWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-edge-'));

// Helper to handle test deadlocks
async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, contextDescription: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[TIMEOUT DEADLOCK DETECTED] "${contextDescription}" failed to resolve within ${timeoutMs}ms. The server event loop or stream reader is hung.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

describe('Orchestrator Edge Case Integration Tests (In-Process)', { timeout: 30000 }, () => {
  let server: http.Server;
  let serverPort: number;
  let proxy: CapiProxy;

  beforeAll(async () => {
    // 1. Boot up the proxy
    proxy = new CapiProxy();
    const proxyUrl = await proxy.start();
    process.env.COPILOT_API_URL = proxyUrl;
    process.env.OPENAI_COMPAT_BASE_URL = proxyUrl;

    // 2. Start the Express server directly in the same process on an ephemeral port
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  }, 30000);

  beforeEach(async () => {
    // Completely flush proxy configurations before every single execution block
    proxy.requestHistory = [];
    proxy.tokenFetchCount = 0;
    await proxy.setOverrides({});
    activeSessions.clear();
  });

  afterAll(async () => {
    // Clean up all localized servers and listeners synchronously
    if (proxy) await proxy.stop();
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(mockProxyWorkDir, { recursive: true, force: true });
  }, 30000);

  it('Test 1: Singleton Concurrency Race (Gap 1)', async () => {
    proxy.tokenFetchCount = 0;

    const run = (id: string) => fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: `race-${id}`, prompt: 'test concurrency', model: 'gemini-3.1-flash-lite' })
    });

    // Fire racing requests simultaneously
    const [res1, res2] = await Promise.all([run('1'), run('2')]);
    
    // Clean up streams completely to keep the event loop unblocked
    await res1.body?.cancel();
    await res2.body?.cancel();

    assert.ok(proxy.tokenFetchCount <= 1, 'Should only fetch token once under initialization promise guards');
  });

  it('Test 2: Session Error Livelock (Gap 2)', async () => {
    await proxy.setOverrides({ injectError: { code: 'rate_limit', message: 'rate limit exceeded' } });

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'livelock-session', prompt: 'trigger error', model: 'gemini-3.1-flash-lite' })
    });

    assert.strictEqual(response.status, 200);
    const reader = response.body!.getReader();
    let errorEmitted = false;
    
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      if (text.includes('session.error') || text.includes('loop.error')) {
        errorEmitted = true;
        await reader.cancel(); // Actively close connection
        break;
      }
    }
    assert.ok(errorEmitted, 'Should unblock loop and emit validation error events gracefully');
  });

  it('Test 3: Clarity Check High Score Auto-Pass (Gap 3)', async () => {
    await proxy.setOverrides({ clarityScore: 0.95 });

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'clarity-pass-session', prompt: 'clear prompt', model: 'gemini-3.1-flash-lite' })
    });

    assert.strictEqual(response.status, 200);
    const reader = response.body!.getReader();
    let clarityFailed = false;
    
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      if (text.includes('loop.clarity_check_failed')) {
        clarityFailed = true;
        await reader.cancel();
        break;
      }
    }
    assert.strictEqual(clarityFailed, false, 'Clarity check should auto-pass when score is >= 0.85');
  });

  it('Test 4: Replay Mismatch Prevention (Gap 4)', async () => {
    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/spec_gate_audit_failure.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: mockProxyWorkDir });

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'mismatch-session', prompt: 'unexpected tool missing from snapshot', model: 'gemini-3.1-flash-lite' })
    });

    assert.strictEqual(response.status, 200);
    const reader = response.body!.getReader();
    let errorEmitted = false;
    
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      if (text.includes('404') || text.includes('error')) {
        errorEmitted = true;
        await reader.cancel();
        break;
      }
    }
    assert.ok(errorEmitted, 'Should encounter mismatch error from the updated proxy matching logic');
  });

  it('Test 5: Loop Retry Disconnect Validation (Gap 5)', async () => {
    // 1. Point the proxy configuration to a snapshot built to trip a gate rule
    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/single_retry.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: mockProxyWorkDir });
    
    proxy.tokenFetchCount = 0;
    proxy.requestHistory = [];

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        sessionId: 'retry-validation-session', 
        prompt: 'always fail lint', 
        model: 'gemini-3.1-flash-lite', 
        maxRetries: 2 
      })
    });

    assert.strictEqual(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    
    const readStreamToCompletion = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
      }
    };
    
    // Guard the stream reading with a generous 15-second timeout to handle container test environments safely
    await awaitWithTimeout(readStreamToCompletion(), 15000, "Exhausting Retry Loop Stream Response");

    // Verify Gap 5 parameters: underlying transport handshake must stay cached (singleton count <= 1)
    // while the SDK engine spins up 3 distinct loop evaluation frames over the sequence tracking historical records.
    assert.ok(proxy.tokenFetchCount <= 1, 'Should reuse the underlying token transport across retry steps');
    
    const completionRequests = proxy.requestHistory.filter(r => r.messages);
    assert.ok(completionRequests.length >= 3, 'Should log at least 3 distinct consecutive completions before failing');
  });
});
