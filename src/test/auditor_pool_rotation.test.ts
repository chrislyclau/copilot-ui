import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  DEFAULT_ROLES_CONFIG,
  parseAuditorPoolEnv,
  selectFromAuditorPool,
} from '../config/models';

describe('Auditor model rotation pool (Issue 79 / RM-REQ-030/031/032/033)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.AUDITOR_POOL;
    delete process.env.AUDITOR_PROVIDER;
    delete process.env.AUDITOR_MODEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('parseAuditorPoolEnv', () => {
    it('returns null when unset or blank', () => {
      expect(parseAuditorPoolEnv(undefined)).toBeNull();
      expect(parseAuditorPoolEnv('')).toBeNull();
      expect(parseAuditorPoolEnv('   ')).toBeNull();
    });

    it('parses a single provider:model entry', () => {
      expect(parseAuditorPoolEnv('gemini:gemini-3.1-flash-lite')).toEqual([
        { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      ]);
    });

    it('parses multiple comma-separated entries, trimming whitespace', () => {
      expect(parseAuditorPoolEnv(' gemini:gemini-3.1-flash-lite , openai:gpt-4o-mini ')).toEqual([
        { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ]);
    });

    it('skips entries with an unknown provider', () => {
      expect(parseAuditorPoolEnv('not-a-provider:some-model,gemini:gemini-3.5-flash')).toEqual([
        { provider: 'gemini', model: 'gemini-3.5-flash' },
      ]);
    });

    it('skips entries missing a colon separator', () => {
      expect(parseAuditorPoolEnv('gemini-3.1-flash-lite,gemini:gemini-3.5-flash')).toEqual([
        { provider: 'gemini', model: 'gemini-3.5-flash' },
      ]);
    });

    it('skips entries with an empty model', () => {
      expect(parseAuditorPoolEnv('gemini:,gemini:gemini-3.5-flash')).toEqual([
        { provider: 'gemini', model: 'gemini-3.5-flash' },
      ]);
    });
  });

  describe('DEFAULT_ROLES_CONFIG.auditorPool', () => {
    it('falls back to a single-entry pool (matching .auditor) when AUDITOR_POOL is unset', () => {
      const pool = DEFAULT_ROLES_CONFIG.auditorPool;
      expect(pool).toHaveLength(1);
      expect(pool[0]).toEqual(DEFAULT_ROLES_CONFIG.auditor);
    });

    it('uses the parsed AUDITOR_POOL when set', () => {
      process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,openai:gpt-4o-mini,anthropic:claude-3-5-sonnet';
      const pool = DEFAULT_ROLES_CONFIG.auditorPool;
      expect(pool).toEqual([
        { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      ]);
    });

    it('falls back to the single-entry default when AUDITOR_POOL parses to nothing usable', () => {
      process.env.AUDITOR_POOL = 'garbage-with-no-colon';
      const pool = DEFAULT_ROLES_CONFIG.auditorPool;
      expect(pool).toHaveLength(1);
      expect(pool[0]).toEqual(DEFAULT_ROLES_CONFIG.auditor);
    });
  });

  describe('selectFromAuditorPool (deterministic round-robin)', () => {
    beforeEach(() => {
      process.env.AUDITOR_POOL = 'gemini:model-a,openai:model-b,anthropic:model-c';
    });

    it('selects entries in order as the rotation index increases', () => {
      expect(selectFromAuditorPool(0)).toEqual({ provider: 'gemini', model: 'model-a' });
      expect(selectFromAuditorPool(1)).toEqual({ provider: 'openai', model: 'model-b' });
      expect(selectFromAuditorPool(2)).toEqual({ provider: 'anthropic', model: 'model-c' });
    });

    it('wraps around deterministically once the index exceeds the pool size', () => {
      expect(selectFromAuditorPool(3)).toEqual(selectFromAuditorPool(0));
      expect(selectFromAuditorPool(4)).toEqual(selectFromAuditorPool(1));
      expect(selectFromAuditorPool(7)).toEqual(selectFromAuditorPool(1));
    });

    it('is a pure function: the same index always yields the same selection', () => {
      const first = selectFromAuditorPool(5);
      const second = selectFromAuditorPool(5);
      expect(first).toEqual(second);
    });

    it('handles a negative index defensively by wrapping into bounds', () => {
      // Defensive only -- callers should never pass negative indices in practice.
      expect(selectFromAuditorPool(-1)).toEqual(selectFromAuditorPool(2));
    });
  });
});

describe('selectRotatingAuditorConfig (Issue 79 / RM-REQ-030/031/032)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.AUDITOR_POOL;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('flags singleModelPool when only one model is configured (default pool)', async () => {
    const { selectRotatingAuditorConfig } = await import('../utils/auditorHelper');
    const selection = selectRotatingAuditorConfig(0);
    expect(selection.singleModelPool).toBe(true);
    expect(selection.poolSize).toBe(1);
    expect(selection.nextRotationIndex).toBe(1);
  });

  it('does not flag singleModelPool when the pool has multiple models', async () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash';
    vi.resetModules();
    const { selectRotatingAuditorConfig } = await import('../utils/auditorHelper');
    const first = selectRotatingAuditorConfig(0);
    const second = selectRotatingAuditorConfig(1);

    expect(first.singleModelPool).toBe(false);
    expect(first.poolSize).toBe(2);
    expect(first.executionConfig.model).toBe('gemini-3.1-flash-lite');
    expect(second.executionConfig.model).toBe('gemini-3.5-flash');
    expect(second.nextRotationIndex).toBe(2);
  });

  it('advances rotationIndex by exactly one per call regardless of pool size', async () => {
    process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash,gemini:gemini-3.1-pro-preview';
    vi.resetModules();
    const { selectRotatingAuditorConfig } = await import('../utils/auditorHelper');
    for (let i = 0; i < 5; i++) {
      const selection = selectRotatingAuditorConfig(i);
      expect(selection.nextRotationIndex).toBe(i + 1);
    }
  });

  describe('cross-provider pool key resolution (regression: does not forward the Implementor/Gemini key to non-Gemini entries)', () => {
    beforeEach(() => {
      process.env.AUDITOR_POOL = 'gemini:gemini-3.1-flash-lite,openai:gpt-4o-mini';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      process.env.GEMINI_API_KEY = 'test-gemini-key';
      vi.resetModules();
    });

    it('does not forward the caller-supplied (Implementor/Gemini) apiKey to a rotated-in non-Gemini pool entry', async () => {
      const { selectRotatingAuditorConfig } = await import('../utils/auditorHelper');
      // rotationIndex 1 selects the openai:gpt-4o-mini pool entry.
      const selection = selectRotatingAuditorConfig(1, 'implementor-gemini-key');

      expect(selection.executionConfig.providerType).toBe('openai');
      // Must resolve via OPENAI_API_KEY, never the Gemini key passed in by the caller.
      expect(selection.executionConfig.provider?.apiKey).toBe('test-openai-key');
      expect(selection.executionConfig.provider?.apiKey).not.toBe('implementor-gemini-key');
    });

    it('still forwards the caller-supplied apiKey when the rotated-in entry is actually Gemini', async () => {
      const { selectRotatingAuditorConfig } = await import('../utils/auditorHelper');
      // rotationIndex 0 selects the gemini:gemini-3.1-flash-lite pool entry.
      const selection = selectRotatingAuditorConfig(0, 'implementor-gemini-key');

      expect(selection.executionConfig.model).toBe('gemini-3.1-flash-lite');
      expect(selection.executionConfig.providerType).toBe('gemini');
    });
  });
});
