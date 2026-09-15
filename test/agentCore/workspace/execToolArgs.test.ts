import { describe, it, expect } from 'vitest';
import { parseExecToolArgs, truncateExecResult, MAX_TOOL_OUTPUT_CHARS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../../../src/agentCore/execTool';
import { resolveWorkDir, TRAVERSAL_ERROR } from '../../../src/agentCore/workspace/execHelpers';

describe('parseExecToolArgs', () => {
  it('parses command, workingDir, and timeoutSeconds', () => {
    expect(parseExecToolArgs({ command: 'ls', workingDir: 'docs', timeoutSeconds: 120 })).toEqual({
      command: 'ls',
      workDir: 'docs',
      timeoutMs: 120_000,
    });
  });

  it('defaults to root workDir and no timeout override', () => {
    expect(parseExecToolArgs({ command: 'pwd' })).toEqual({ command: 'pwd', workDir: undefined, timeoutMs: undefined });
    expect(parseExecToolArgs(undefined)).toEqual({ command: '', workDir: undefined, timeoutMs: undefined });
  });

  it('clamps timeoutSeconds into the 30..600 window (bash-tool parity)', () => {
    expect(parseExecToolArgs({ command: 'x', timeoutSeconds: 5 }).timeoutMs).toBe(MIN_TIMEOUT_SECONDS * 1000);
    expect(parseExecToolArgs({ command: 'x', timeoutSeconds: 100_000 }).timeoutMs).toBe(MAX_TIMEOUT_SECONDS * 1000);
    expect(parseExecToolArgs({ command: 'x', timeoutSeconds: Number.NaN }).timeoutMs).toBeUndefined();
    expect(parseExecToolArgs({ command: 'x', timeoutSeconds: '120' }).timeoutMs).toBeUndefined();
  });
});

describe('resolveWorkDir', () => {
  const ROOT = '/ws/root';

  it('resolves relative paths against the workspace root', () => {
    expect(resolveWorkDir('docs', ROOT)).toEqual({ ok: true, dir: '/ws/root/docs' });
    expect(resolveWorkDir('./src/../test', ROOT)).toEqual({ ok: true, dir: '/ws/root/test' });
  });

  it('keeps absolute paths that stay inside the root', () => {
    expect(resolveWorkDir('/ws/root/deep/dir', ROOT)).toEqual({ ok: true, dir: '/ws/root/deep/dir' });
    expect(resolveWorkDir('/ws/root', ROOT)).toEqual({ ok: true, dir: ROOT });
  });

  it('rejects traversal in both relative and absolute form', () => {
    expect(resolveWorkDir('../../etc', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('docs/../../..', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('/etc', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
    expect(resolveWorkDir('/ws/rootEvil', ROOT)).toEqual({ ok: false, error: TRAVERSAL_ERROR });
  });

  it('treats empty/blank as the workspace root', () => {
    expect(resolveWorkDir(undefined, ROOT)).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('', ROOT)).toEqual({ ok: true, dir: ROOT });
    expect(resolveWorkDir('   ', ROOT)).toEqual({ ok: true, dir: ROOT });
  });
});

describe('truncateExecResult', () => {
  it('leaves small results untouched', () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(truncateExecResult(result)).toEqual(result);
  });

  it('caps oversized stdout with a head+tail window and a notice', () => {
    const big = 'A'.repeat(10_000) + 'Q'.repeat(60_000) + 'MIDDLE_MARK' + 'Q'.repeat(60_000) + 'Z'.repeat(10_000);
    const result = truncateExecResult({ stdout: big, stderr: '', exitCode: 0 });
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(result.stdout.startsWith('A'.repeat(100))).toBe(true);
    expect(result.stdout.endsWith('Z'.repeat(100))).toBe(true);
    expect(result.stdout).toContain('Output truncated');
    expect(result.stdout).not.toContain('MIDDLE_MARK');
  });

  it('truncates stderr independently', () => {
    const result = truncateExecResult({ stdout: '', stderr: 'E'.repeat(MAX_TOOL_OUTPUT_CHARS + 1), exitCode: 1 });
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(result.stderr).toContain('Output truncated');
  });
});
