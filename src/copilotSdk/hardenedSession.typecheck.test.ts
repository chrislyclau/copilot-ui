import { describe, it, expect } from 'vitest';
import type { HardenedSessionBaseConfig } from './hardenedSession';

/**
 * Type-only assertions for issue #246 item 4: "Make the config type
 * non-optional so a resume path omitting `availableTools`/`autoApproveAll`/
 * `onPermissionRequest` fails type-check."
 *
 * `HardenedSessionBaseConfig` (`Omit<SessionConfig, PolicyOwnedConfigKeys>`)
 * is what `createHardenedSession`/`resumeHardenedSession` accept as their
 * caller-supplied config. These assertions guard against a regression where
 * `PolicyOwnedConfigKeys` in hardenedSession.ts is narrowed (e.g. a field
 * removed from the Omit), which would silently let a caller supply their own
 * `availableTools`/`tools`/`systemMessage`/`autoApproveAll`/
 * `onPermissionRequest` again -- the exact "partial resumeConfig" failure
 * mode this module exists to close off.
 *
 * Per this repo's type-discipline guide, suppression-comment escape
 * hatches (and `any`) are forbidden -- including in tests -- so this can't assert "this
 * assignment errors" via a suppression comment. Instead it's a positive,
 * always-must-compile canary: `PolicyOwnedKeyOverlap` computes the
 * intersection between `HardenedSessionBaseConfig`'s own keys and the keys
 * that must remain policy-owned. That intersection is typed as `never`
 * below; if a future edit reintroduces one of those keys into
 * `HardenedSessionBaseConfig`, the intersection stops being `never`, and the
 * `satisfies never` on the next line fails `tsc --noEmit` -- no suppression
 * comment involved, an ordinary compile error the same way any other type
 * regression would be caught.
 */
type PolicyOwnedKeys =
  | 'availableTools'
  | 'tools'
  | 'systemMessage'
  | 'autoApproveAll'
  | 'onPermissionRequest';

type PolicyOwnedKeyOverlap = Extract<keyof HardenedSessionBaseConfig, PolicyOwnedKeys>;

// Compiles only while `HardenedSessionBaseConfig` excludes every policy-owned
// key. If any of those keys leak back in, `PolicyOwnedKeyOverlap` becomes
// non-`never` and this line fails `tsc --noEmit`.
type _AssertNoPolicyOwnedKeysLeak = PolicyOwnedKeyOverlap extends never ? true : false;
const _assertNoPolicyOwnedKeysLeak: _AssertNoPolicyOwnedKeysLeak = true;

// A genuinely caller-owned field (e.g. `model`) must remain assignable --
// this is the same assertion technique from the other side: `model` should
// still be `keyof HardenedSessionBaseConfig`, so `Extract` should NOT be
// `never` here.
type CallerOwnedKeyStillPresent = Extract<keyof HardenedSessionBaseConfig, 'model'>;
type _AssertCallerOwnedKeyStillPresent = CallerOwnedKeyStillPresent extends never ? false : true;
const _assertCallerOwnedKeyStillPresent: _AssertCallerOwnedKeyStillPresent = true;

describe('HardenedSessionBaseConfig (type-level)', () => {
  it('excludes every policy-owned key from the caller-supplied base config', () => {
    // Nothing to execute -- the invariant is enforced by the type-level
    // canary above at `tsc --noEmit` time. This assertion just documents
    // and surfaces the guarantee in test output.
    expect(_assertNoPolicyOwnedKeysLeak).toBe(true);
  });

  it('still allows genuinely caller-owned fields (e.g. model) through', () => {
    const config: HardenedSessionBaseConfig = { model: 'claude-sonnet-4.5' };
    expect(config).toBeDefined();
    expect(_assertCallerOwnedKeyStillPresent).toBe(true);
  });
});
