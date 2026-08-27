// SYS-REQ-029f: omitting the lock selection for a lock-eligible tool must
// be a compile-time error. This file is exercised only by `tsc --noEmit`
// (it is not a vitest test, and asserts nothing at runtime) -- each
// `@ts-expect-error` below fails the build if the following statement
// *stops* being a type error, which is exactly the regression this guards.
import type { ToolLockPolicy } from './sessionFactory';

// Valid: both variants require `mode` and `rationale`, nothing else is optional-away.
const locked: ToolLockPolicy = { mode: 'locked', rationale: 'gate on live orchestration state' };
const unlocked: ToolLockPolicy = { mode: 'unlocked', rationale: 'always available, no session dependency' };
void locked;
void unlocked;

// @ts-expect-error -- `mode` is required; there is no default lock selection.
const missingMode: ToolLockPolicy = { rationale: 'no mode supplied' };
void missingMode;

// @ts-expect-error -- `rationale` is required for every lock selection (SYS-REQ-029i).
const missingRationale: ToolLockPolicy = { mode: 'locked' };
void missingRationale;
