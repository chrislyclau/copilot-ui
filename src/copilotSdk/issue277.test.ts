import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveAutoApprovedTools,
  deriveSessionConfig,
  BUILTIN_TOOL_PERMISSION_KIND,
  SessionPolicy,
} from './hardenedSession';

/**
 * Regression tests for issue #277: `availableTools` (wire names) and
 * `autoApprovedTools` (permission kinds) are two different namespaces for
 * built-in tools, and callers who don't know that get a silently broken
 * policy.
 */
describe('deriveAutoApprovedTools (issue #277)', () => {
  it('maps known built-in wire names to their permission kind', () => {
    expect(deriveAutoApprovedTools(['bash'])).toEqual(['shell']);
    expect(deriveAutoApprovedTools(['view'])).toEqual(['read']);
    expect(deriveAutoApprovedTools(['grep'])).toEqual(['read']);
    expect(deriveAutoApprovedTools(['glob'])).toEqual(['read']);
  });

  it('de-duplicates kinds when multiple wire names collapse to the same kind', () => {
    expect(deriveAutoApprovedTools(['view', 'grep', 'glob'])).toEqual(['read']);
  });

  it('passes through names with no known built-in mapping unchanged (custom/MCP/hook tool names)', () => {
    expect(deriveAutoApprovedTools(['my_custom_tool', 'github-list_issues'])).toEqual([
      'my_custom_tool',
      'github-list_issues',
    ]);
  });

  it('mixes built-ins and custom tools correctly', () => {
    expect(deriveAutoApprovedTools(['bash', 'view', 'my_custom_tool'])).toEqual([
      'shell',
      'read',
      'my_custom_tool',
    ]);
  });

  it('BUILTIN_TOOL_PERMISSION_KIND only covers the wire names this codebase actually uses', () => {
    expect(BUILTIN_TOOL_PERMISSION_KIND).toEqual({
      bash: 'shell',
      view: 'read',
      grep: 'read',
      glob: 'read',
    });
  });
});

describe('deriveSessionConfig warns on misconfigured autoApprovedTools (issue #277)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
    return {
      availableTools: ['bash'],
      autoApprovedTools: ['bash'],
      ...overrides,
    };
  }

  it('warns when autoApprovedTools contains a raw built-in wire name instead of its kind', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deriveSessionConfig(makePolicy({ autoApprovedTools: ['bash', 'view'] }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("'bash'");
    expect(message).toContain("'view'");
    expect(message).toContain('issue #277');
  });

  it('does not warn when autoApprovedTools correctly uses permission kinds', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deriveSessionConfig(makePolicy({ autoApprovedTools: ['shell', 'read'] }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a policy with no built-in tools involved at all', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deriveSessionConfig(makePolicy({ availableTools: ['my_custom_tool'], autoApprovedTools: ['my_custom_tool'] }));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
