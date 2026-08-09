import { describe, it, expect } from 'vitest';

// Issue #320: buildAuditorSessionDeclarativeSettings and isAIStudio are the
// two reference cases for the *.pure.ts convention -- config/args in,
// plain value out, no closures, no I/O imports. These tests guard that the
// pure half stays pure in behavior (deterministic given its inputs) and
// that the declarative shape it returns has no handler functions on it.

import { buildAuditorSessionDeclarativeSettings } from '../utils/auditorHelper.pure';
import { RUN_TERMINAL_DOCKER_TOOL } from '../config/tools';

describe('buildAuditorSessionDeclarativeSettings (issue #320 reference case 1)', () => {
  const executionConfig = { model: 'mock-model', provider: undefined } as never;
  const tool = {
    function: {
      name: 'submit_task_result',
      description: 'Submit result',
      parameters: { type: 'object', properties: {} },
    },
  };

  it('returns a declarative shape with no handler functions', () => {
    const settings = buildAuditorSessionDeclarativeSettings(executionConfig, 'system prompt', tool);
    expect(settings.toolMeta).not.toHaveProperty('handler');
    expect(settings.execToolMeta).not.toHaveProperty('handler');
    expect(typeof settings.toolMeta.name).toBe('string');
  });

  it('carries the task-specific tool name and the exec tool name', () => {
    const settings = buildAuditorSessionDeclarativeSettings(executionConfig, 'system prompt', tool);
    expect(settings.toolMeta.name).toBe('submit_task_result');
    expect(settings.execToolMeta.name).toBe(RUN_TERMINAL_DOCKER_TOOL.function.name);
  });

  it('is deterministic: identical inputs produce identical output', () => {
    const a = buildAuditorSessionDeclarativeSettings(executionConfig, 'same prompt', tool);
    const b = buildAuditorSessionDeclarativeSettings(executionConfig, 'same prompt', tool);
    expect(a).toEqual(b);
  });

  it('embeds the system prompt into the assembled system message content', () => {
    const settings = buildAuditorSessionDeclarativeSettings(executionConfig, 'UNIQUE_MARKER_XYZ', tool);
    expect(settings.systemMessage.mode).toBe('replace');
    expect(settings.systemMessage.content).toContain('UNIQUE_MARKER_XYZ');
  });
});

describe('isAIStudio (issue #320 reference case 2)', () => {
  // Imported dynamically per-test so each test can freely mutate
  // process.env without module-load-time caching surprises.
  it('is a pure function of process.env with no I/O side effects', async () => {
    const { isAIStudio } = await import('../workspace/workspace.pure');
    const original = { ...process.env };
    try {
      process.env.AI_STUDIO = 'true';
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      expect(isAIStudio()).toBe(true);

      process.env.AI_STUDIO = 'false';
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      expect(isAIStudio()).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
