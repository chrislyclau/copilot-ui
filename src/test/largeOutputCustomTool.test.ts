import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from './harness/CapiProxy';
import { CopilotClient } from '../copilotSdk/boundary';

// How big a payload to return from the custom tool. Comfortably above the
// SDK's documented LargeToolOutputConfig default of 51200 bytes so we can
// tell whether the runtime intervened at all.
const HUGE_PAYLOAD_SIZE = 200_000;
const HUGE_PAYLOAD = 'X'.repeat(HUGE_PAYLOAD_SIZE);

describe('LargeToolOutputConfig with a custom (non-built-in) tool', () => {
  it('reports whether a >50KB custom-tool result is truncated/referenced before being sent back to the model', { timeout: 60000 }, async () => {
    const proxy = new CapiProxy();
    const proxyUrl = await proxy.start();
    const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-output-'));

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/large_output/big_output.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tempWorkDir });

    const client = new CopilotClient({
      workingDirectory: tempWorkDir,
      logLevel: 'none',
      useLoggedInUser: false,
      env: {
        ...process.env,
        ...proxy.getProxyEnv(),
        COPILOT_API_URL: proxyUrl,
      },
    });

    try {
      await client.start();

      const session = await client.createSession({
        model: 'claude-sonnet-4.5',
        provider: {
          type: 'openai',
          baseUrl: proxyUrl,
          apiKey: 'test-api-key',
        },
        systemMessage: { mode: 'replace', content: 'Test System Message' },
        // Explicitly set so the behavior isn't left to whatever the runtime
        // default happens to be -- we want to know if THIS config affects
        // a *custom* tool's result.
        largeOutput: {
          enabled: true,
          maxSizeBytes: 51200,
        },
        tools: [
          {
            name: 'big_output_tool',
            description: 'Returns a large payload to test context-bloat handling.',
            parameters: { type: 'object', properties: {} },
            handler: async () => {
              return HUGE_PAYLOAD;
            },
          },
        ],
        streaming: false,
      });

      await session.sendAndWait({ prompt: 'Run the big output tool.' }, 30000);
      await session.disconnect();
    } finally {
      await client.stop();
      await proxy.stop();
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    }

    // The second /chat/completions request is the one that includes the
    // tool result. Find the "tool" message and inspect what actually got
    // sent -- this is the ground truth, independent of any assumption
    // about how the SDK's types *should* behave.
    const secondRequest = proxy.requestHistory[1];
    assert.ok(secondRequest, 'Expected a second request carrying the tool result');

    const toolMessage = secondRequest.messages.find((m: any) => m.role === 'tool');
    assert.ok(toolMessage, 'Expected a role:"tool" message in the second request');

    const sentContent: string = typeof toolMessage.content === 'string'
      ? toolMessage.content
      : JSON.stringify(toolMessage.content);

    console.log(`[RESULT] tool message content length sent to model: ${sentContent.length} bytes (raw handler output was ${HUGE_PAYLOAD_SIZE} bytes)`);
    console.log(`[RESULT] first 300 chars: ${sentContent.slice(0, 300)}`);

    if (sentContent.length < HUGE_PAYLOAD_SIZE) {
      console.log('[CONCLUSION] Large-output handling DID intervene for a custom tool -- content was shortened/replaced before reaching the model.');
    } else {
      console.log('[CONCLUSION] Large-output handling did NOT intervene -- the full raw payload was sent to the model for this custom tool.');
    }
  });
});
