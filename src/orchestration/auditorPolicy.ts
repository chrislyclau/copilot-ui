import { ProviderRegistry, ExecutionConfig } from '../agentCore/providerRegistry';
import { DEFAULT_ROLES_CONFIG, getAuditorTierConfig, selectFromAuditorPool, getProviderRegistryConfig, ModelProviderConfig } from '../config/models';


/**
 * Shared logic to resolve a role's ExecutionConfig via ProviderRegistry: pick
 * up an explicit apiKey if given, otherwise fall back to the provider's env
 * var. Throws a loud error if no API key is available for a provider that
 * needs one. Shared by the auditor (single-tier/tiered/pooled), reviewer,
 * and any future role -- keeps the provider/API-key resolution rules in one
 * place instead of copy-pasted per role.
 */
function resolveExecutionConfig(roleConfig: ModelProviderConfig, roleLabel: string, apiKey?: string): ExecutionConfig {
  const provider = roleConfig.provider;
  let keyToUse = apiKey;
  let envVarName = 'GEMINI_API_KEY';
  if (!keyToUse) {
    if (provider === 'gemini') {
      keyToUse = process.env.GEMINI_API_KEY;
      envVarName = 'GEMINI_API_KEY';
    } else if (provider === 'anthropic') {
      keyToUse = process.env.ANTHROPIC_API_KEY;
      envVarName = 'ANTHROPIC_API_KEY';
    } else if (provider === 'openai') {
      keyToUse = process.env.OPENAI_API_KEY;
      envVarName = 'OPENAI_API_KEY';
    } else if (provider === 'openrouter') {
      keyToUse = process.env.OPENROUTER_API_KEY;
      envVarName = 'OPENROUTER_API_KEY';
    }
  }

  if (!keyToUse && provider !== 'copilot-native' && provider !== 'local') {
    throw new Error(
      `Missing API key for ${roleLabel} provider "${provider}". Expected ${envVarName} to be set.`,
    );
  }
  const registry = new ProviderRegistry(keyToUse, getProviderRegistryConfig());
  return registry.getExecutionConfig(roleConfig);
}

/**
 * Shared logic to resolve the auditor's execution configuration via ProviderRegistry.
 * Ensures both auditors respect DEFAULT_ROLES_CONFIG.auditor.provider. * Throws a loud error if no API key is available for the required provider.
 *
 * `tierIndex` selects a rung on the auditor escalation ladder (Issue 81 /
 * RM-REQ-021), defaulting to tier 0 -- the same single-tier config this
 * function always resolved before the ladder existed, so existing callers
 * (e.g. the per-task Spec-Gate Auditor) are unaffected.
 *
 * This is intentionally independent of the pool-rotation mechanism below
 * (Issue 79 / RM-REQ-033): the compliance-audit operation's tiering must
 * not be conflated with the general auditor's rotation pool.
 */
export function getAuditorExecutionConfig(apiKey?: string, tierIndex: number = 0): ExecutionConfig {
  const auditorConfig = getAuditorTierConfig(tierIndex);
  return resolveExecutionConfig(auditorConfig, 'auditor', apiKey);
}

export interface RotatingAuditorSelection {
  readonly executionConfig: ExecutionConfig;
  /** Number of models currently configured in the pool. */
  readonly poolSize: number;
  /** The pool index actually selected for this call (rotationIndex normalized into pool bounds). */
  readonly selectedIndex: number;
  /** Value to persist as the rotation index for the *next* call (RM-REQ-031: session-persisted, deterministic). */
  readonly nextRotationIndex: number;
  /** True when the configured pool has only one model (RM-REQ-032: warn, don't block). */
  readonly singleModelPool: boolean;
}

/**
 * Round-robin auditor selection from DEFAULT_ROLES_CONFIG.auditorPool
 * (Issue 79 / RM-REQ-030/031). Pure with respect to session state: callers
 * are responsible for reading the current rotationIndex out of session
 * state before calling this, and persisting `nextRotationIndex` back after
 * (see StateSnapshot.auditorRotationIndex) -- this function does not read
 * or write any session store itself, so it stays trivially testable and
 * avoids a dependency on the session-state module (which itself depends on
 * this one).
 *
 * Warnings (single-model pool, decorrelation) are reported back via the
 * returned flags rather than logged here directly, so callers can route
 * them through whatever logger/session-event mechanism they already use.
 */
export function selectRotatingAuditorConfig(rotationIndex: number, apiKey?: string): RotatingAuditorSelection {
  const pool = DEFAULT_ROLES_CONFIG.auditorPool;
  if (pool.length === 0) {
    throw new Error('Auditor pool is empty');
  }
  const normalizedIndex = ((rotationIndex % pool.length) + pool.length) % pool.length;
  const auditorConfig = selectFromAuditorPool(normalizedIndex);

  // The `apiKey` passed in here originates upstream as the Implementor's key,
  // which is always a Gemini key (gateLoop's `keyToUse = apiKey ||
  // process.env.GEMINI_API_KEY`). For a multi-provider pool
  // (e.g. AUDITOR_POOL=gemini:...,openai:gpt-4o-mini), forwarding that key
  // verbatim into resolveExecutionConfig for a non-Gemini selection would
  // send the wrong provider's API key and break auth. Only forward it when
  // the selected pool entry is actually a Gemini entry; otherwise let
  // resolveExecutionConfig fall back to that provider's own env var
  // (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
  const keyForSelectedProvider = auditorConfig.provider === 'gemini' ? apiKey : undefined;
  const executionConfig = resolveExecutionConfig(auditorConfig, 'auditor pool', keyForSelectedProvider);

  return {
    executionConfig,
    poolSize: pool.length,
    selectedIndex: normalizedIndex,
    nextRotationIndex: rotationIndex + 1,
    singleModelPool: pool.length <= 1,
  };
}

/**
 * Shared instruction, reused by both the PR-reviewer and codebase-audit agent
 * prompts: when checking a code change against spec requirements, an agent
 * must not resolve disagreements between authoritative artifacts on its own
 * -- it must escalate by reporting a blocking finding that plainly names
 * which artifacts say what (see issue #292).
 */
export function crossArtifactDisagreementInstruction(): string {
  return `**Cross-Artifact Disagreement:**
- When checking a code change against spec requirements, if two or more of {spec doc, JSON schema, TS interface, system prompt text} disagree about the same requirement, do not resolve the disagreement yourself (e.g. by picking whichever you encountered first, or by recommending which artifact should change). Report it as a 'blocking' finding that plainly names which artifacts say what, and stop there.`;
}

/**
 * Shared logic to resolve the reviewer's execution configuration via ProviderRegistry.
 * Independently configurable from the auditor role (REVIEWER_PROVIDER/REVIEWER_MODEL),
 * so PR-facing review can use a different, likely stronger, model without affecting
 * the in-loop spec auditor.
 * Throws a loud error if no API key is available for the required provider.
 */
export function getReviewerExecutionConfig(apiKey?: string): ExecutionConfig {
  return resolveExecutionConfig(DEFAULT_ROLES_CONFIG.reviewer, 'reviewer', apiKey);
}
