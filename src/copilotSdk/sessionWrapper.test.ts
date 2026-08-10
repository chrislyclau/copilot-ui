import { describe, it, expect } from 'vitest';
import { SessionWrapper } from './sessionWrapper';
import type { PermissionRequest } from './boundary';

function shellRequest(): PermissionRequest {
  return { kind: 'shell' } as PermissionRequest;
}

function readRequest(): PermissionRequest {
  return { kind: 'read' } as PermissionRequest;
}

function customToolRequest(toolName: string): PermissionRequest {
  return { kind: 'custom-tool', toolName } as PermissionRequest;
}

describe('SessionWrapper._createConfig', () => {
  it('with zero tools: denies every candidate and reports no availableTools', async () => {
    const wrapper = new SessionWrapper();
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([]);
    expect(config.autoApproveAll).toBe(false);
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
    expect(typeof config.systemMessage === 'object' ? config.systemMessage?.content : '').toContain(
      'No tools are available'
    );
  });

  it('with one built-in tool: system-prompt section, availableTools, and permission never disagree', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash']);
    expect(config.systemMessage?.content).toContain('bash');
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    // A candidate not in the tool list is still denied.
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('with N mixed built-in and custom tools: every candidate resolves consistently', async () => {
    const wrapper = new SessionWrapper().addTools('bash', 'view', 'grep', 'glob', 'edit', 'my_custom_tool');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash', 'view', 'grep', 'glob', 'edit', 'my_custom_tool']);
    for (const req of [shellRequest(), readRequest(), customToolRequest('my_custom_tool')]) {
      await expect(config.onPermissionRequest(req, { sessionId: 's1' })).resolves.toEqual({
        kind: 'approve-once',
      });
    }
    await expect(config.onPermissionRequest(customToolRequest('unlisted_tool'), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('approval is per-call, not a standing grant: repeated calls to an allowed tool are each independently approved', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('removeTools denies the tool once _createConfig is re-derived (next-turn semantics)', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const firstTurnConfig = wrapper._createConfig();
    await expect(firstTurnConfig.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });

    wrapper.removeTools('bash');
    const nextTurnConfig = wrapper._createConfig();
    expect(nextTurnConfig.availableTools).toEqual([]);
    await expect(nextTurnConfig.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('folds tool guidance into an unset system prompt as append mode', () => {
    const config = new SessionWrapper().addTools('bash')._createConfig();
    expect(config.systemMessage?.mode).toBe('append');
  });

  it('folds tool guidance into a caller-supplied replace-mode system prompt without dropping caller content', () => {
    const wrapper = new SessionWrapper().addTools('bash').setSystemPrompt({ mode: 'replace', content: 'be terse' });
    const config = wrapper._createConfig();
    expect(config.systemMessage?.mode).toBe('replace');
    expect(config.systemMessage?.content).toContain('be terse');
    expect(config.systemMessage?.content).toContain('bash');
  });

  it('passes _modelName through to the derived config', () => {
    const config = new SessionWrapper().setModelName('claude-sonnet-4.5')._createConfig();
    expect(config.model).toBe('claude-sonnet-4.5');
  });
});
