import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import assert from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app, activeSessions } from '../../server';
import { activeBackgroundRuns } from '../../src/orchestration/orchestrator/gateLoop';
import { CapiProxy } from '../harness/CapiProxy';

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
    process.env.GEMINI_API_KEY = 'test-key';

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
    const snapshotPath = path.resolve(process.cwd(), 'test/snapshots/gate_loop/spec_gate_audit_failure.yaml');
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
    const snapshotPath = path.resolve(process.cwd(), 'test/snapshots/gate_loop/single_retry.yaml');
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

    // Read only until the loop's retry machinery fires once (failing gate ->
    // `loop.retry`), then disconnect. The full escalation ladder (3 model tiers
    // x (maxRetries + 1) attempts = 9 loop cycles) takes 20s+ even locally and
    // 30s+ on 2-core CI runners, but neither assertion below needs it: by the
    // time the first `loop.retry` is emitted, the gate has already failed after
    // >= 3 proxied completions on the first cycle. Waiting for the whole ladder
    // was pure deadlock-bait -- it caused the CI timeout flake that a previous
    // commit papered over with an inflated per-test timeout.
    // The scan matches against accumulated decoded text (not per-chunk) so a
    // `loop.retry` marker split across two SSE chunks is still found, and the
    // accumulated text is asserted on below so a stream that ends without the
    // marker fails the test instead of passing vacuously.
    const readUntilFirstRetry = async () => {
      let accumulated = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return accumulated;
        accumulated += decoder.decode(value, { stream: true });
        if (accumulated.includes('loop.retry')) {
          await reader.cancel(); // Actively close connection (the "disconnect" under validation)
          return accumulated;
        }
      }
    };

    const streamText = await awaitWithTimeout(readUntilFirstRetry(), 15000, "First loop.retry event (gate-failure retry)");
    assert.ok(
      streamText.includes('loop.retry'),
      `Stream ended without emitting loop.retry (gate-failure retry machinery never fired). Stream tail: ${streamText.slice(-300)}`
    );

    // Verify Gap 5 parameters: underlying transport handshake must stay cached (singleton count <= 1)
    // across the retry step, while the SDK engine logs the consecutive completions that led to the failure.
    assert.ok(proxy.tokenFetchCount <= 1, 'Should reuse the underlying token transport across retry steps');

    const completionRequests = proxy.requestHistory.filter(r => r.messages);
    assert.ok(completionRequests.length >= 3, 'Should log at least 3 distinct consecutive completions before failing');

    // The loop keeps running server-side after the client disconnects (by
    // design). Abort it via the panic endpoint and wait for it to unwind so
    // afterAll's proxy/server teardown never races a live ladder.
    //
    // Poll `activeBackgroundRuns`, not `activeLocks`: the panic handler deletes
    // the activeLocks entry itself before responding, so a lock-map poll can
    // never fail. The activeBackgroundRuns entry is only deleted in the run
    // promise's finally (gateLoop.ts), i.e. after the loop has actually
    // unwound -- a real unwind signal.
    await fetch(`http://127.0.0.1:${serverPort}/api/copilot/panic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'retry-validation-session' })
    });
    const unwindDeadline = Date.now() + 10000;
    while (activeBackgroundRuns.has('retry-validation-session') && Date.now() < unwindDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      !activeBackgroundRuns.has('retry-validation-session'),
      'Background loop should unwind after the panic abort (activeBackgroundRuns entry must be cleared by the run promise finally)'
    );
  });
});
