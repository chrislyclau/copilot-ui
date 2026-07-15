import { CapiProxy } from './CapiProxy';
import * as path from 'path';
import * as fs from 'fs';
import { initializeWorkspace } from '../../workspace';
import { GitSandbox } from '../../workspace/git';
import * as native from '../../workspace/nativeRunner';
import { __setGitSandboxForTests } from '../vitest.setup';

// Test-only reset helpers. These replace the old resetWorkspaceForTests()/
// resetNativeWorkspace() exports (removed from workspace.ts/nativeRunner.ts,
// which no longer have any mutable state of their own to reset). Built
// entirely from the public surface: GitSandbox, and nativeRunner's exported
// getWorkspaceRoot/getGitDir/execCommand. The fresh sandbox is installed via
// the vitest.setup.ts mock's setter so getGitSandbox() picks it up.
async function resetNativeWorkspace(): Promise<void> {
  const root = native.getWorkspaceRoot();
  for (const entry of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

async function resetWorkspaceForTests(): Promise<void> {
  // Wipe first, then reinitialize — reinitializing before wiping would
  // delete the fresh .git the new sandbox just created.
  await resetNativeWorkspace();
  const sandbox = new GitSandbox(
    native.getWorkspaceRoot(),
    native.getGitDir(),
    native.execCommand
  );
  await sandbox.initializeGitSandboxAsync();
  __setGitSandboxForTests(sandbox);
}

class ServerHarness {
  private serverProcess: any = null;
  public proxy: CapiProxy | null = null;
  public serverPort: string = '';
  public proxyUrl: string = '';
  public serverModule: any;
  private isInitializing: boolean = false;
  private isStarted: boolean = false;

  async start(): Promise<{ serverPort: string; proxyUrl: string; proxy: CapiProxy }> {
    if (this.isStarted) {
      return { serverPort: this.serverPort, proxyUrl: this.proxyUrl, proxy: this.proxy! };
    }
    if (this.isInitializing) {
      while (!this.isStarted) {
        await new Promise(r => setTimeout(r, 100));
      }
      return { serverPort: this.serverPort, proxyUrl: this.proxyUrl, proxy: this.proxy! };
    }

    this.isInitializing = true;

    // 1. Start CapiProxy first to get the URL
    this.proxy = new CapiProxy();
    this.proxyUrl = await this.proxy.start();
    console.log(`[ServerHarness] CapiProxy listening at ${this.proxyUrl}`);

    // 2. Set environment variables for the current process
    // These must be set BEFORE importing server.ts
    process.env.COPILOT_API_URL = this.proxyUrl;
    process.env.OPEN_AI_BASE_URL = this.proxyUrl;
    process.env.OPENAI_COMPAT_BASE_URL = this.proxyUrl;
    process.env.NODE_ENV = 'test';
    process.env.GEMINI_API_KEY = 'test-key';

    await initializeWorkspace();

    try {
      // 3. Dynamic import of server.ts (it exports the Express app)
      this.serverModule = await import('../../../server.ts');
      
      // Use port 0 for ephemeral port to avoid conflicts
      this.serverProcess = this.serverModule.app.listen(0, '127.0.0.1', () => {
        const addr = this.serverProcess.address();
        this.serverPort = String(addr.port);
        console.log(`[ServerHarness] In-process server running on port ${this.serverPort}`);
      });
    } catch (err) {
      console.error('[ServerHarness] Failed to start server in-process:', err);
      this.isInitializing = false;
      throw err;
    }

    // Wait for server to start by polling /api/health
    let started = false;
    for (let i = 0; i < 30; i++) {
      try {
        if (this.serverPort) {
          const hres = await fetch(`http://127.0.0.1:${this.serverPort}/api/health`);
          if (hres.ok) {
            started = true;
            break;
          }
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }

    if (!started) {
      this.isInitializing = false;
      throw new Error('[ServerHarness] In-process server failed to start and respond to /api/health');
    }

    this.isStarted = true;
    this.isInitializing = false;

    return { serverPort: this.serverPort, proxyUrl: this.proxyUrl, proxy: this.proxy };
  }

  async stop(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.close();
      this.serverProcess = null;
    }
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    await resetWorkspaceForTests();
    this.isStarted = false;
  }
}

export const serverHarness = new ServerHarness();
