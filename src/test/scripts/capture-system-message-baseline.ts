/**
 * Re-run this whenever @github/copilot-sdk is upgraded to check whether
 * src/copilotSdk/systemMessageBaseline.ts's FROZEN_SDK_SYSTEM_MESSAGE_BASELINE
 * has drifted from what the installed SDK actually generates (see #345).
 * This does NOT write systemMessageBaseline.ts for you -- it writes a raw
 * capture to /tmp for you to diff by hand and fold in deliberately,
 * including re-stripping the environment_context/session_context sections
 * (see the comment on FROZEN_SDK_SYSTEM_MESSAGE_BASELINE for why those two
 * are cut rather than templated).
 *
 * Lives under src/test/ (rather than scripts/) and is deliberately named
 * without a `.test.ts` suffix: it exercises `CopilotClient.createSession`
 * directly against a real (proxied) SDK on purpose (see the comment on
 * that call below), which is exactly what src/test/**'s integration-test
 * files are already trusted to do, so it belongs alongside them rather
 * than under scripts/, whose lint rule assumes production call sites. The
 * `.ts` (not `.test.ts`) extension keeps `vitest run` from picking it up
 * as a suite -- it's a manual, human-triggered capture, not a test.
 *
 * Usage: npx tsx src/test/scripts/capture-system-message-baseline.ts
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { CapiProxy } from '../harness/CapiProxy';
import { CopilotClient } from '../../copilotSdk/boundary';
import { stripSdkGeneratedDynamicSections } from '../../copilotSdk/systemMessageBaseline';

// ESM (package.json "type": "module") has no ambient __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const proxy = new CapiProxy();
  const proxyUrl = await proxy.start();
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-'));

  const snapshotPath = path.resolve(
    __dirname,
    '../snapshots/session_wrapper/create_resume.yaml'
  );
  await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

  const client = new CopilotClient({
    workingDirectory: tmpWorkDir,
    logLevel: 'none',
    useLoggedInUser: false,
    env: {
      ...process.env,
      ...proxy.getProxyEnv(),
      COPILOT_API_URL: proxyUrl,
    },
  });

  await client.start();
  try {
    // No tools at all, default systemMessage (append mode, no content) -- the
    // purest baseline: whatever the SDK injects with nothing from us.
    const session = await client.createSession({
      model: 'claude-sonnet-4.5',
      provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' },
      availableTools: [],
      autoApproveAll: false,
      onPermissionRequest: async () => ({ kind: 'reject', feedback: 'no tools' }),
    } as any);

    await session.sendAndWait('Hello', 15000);

    const completions = proxy.requestHistory.filter((r: any) => Array.isArray(r.messages));
    const sys = completions[0]?.messages.find((m: any) => m.role === 'system')?.content ?? '';
    const outPath = path.join(os.tmpdir(), 'copilot-sdk-system-message-capture.txt');
    fs.writeFileSync(outPath, sys);
    // Same shared stripper the staleness test uses -- printed here too so a
    // human re-running this by hand sees the exact text that test compares
    // against `FROZEN_SDK_SYSTEM_MESSAGE_BASELINE`, not the raw unstripped
    // capture.
    const strippedOutPath = path.join(os.tmpdir(), 'copilot-sdk-system-message-capture.stripped.txt');
    fs.writeFileSync(strippedOutPath, stripSdkGeneratedDynamicSections(sys));
    console.log('Captured', sys.length, 'chars to', outPath);
    console.log('Stripped capture written to', strippedOutPath);
  } finally {
    await client.stop();
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
