export const PROVIDERS = [
  "copilot-native",
  "openai",
  "anthropic",
  "gemini",
  "local",
  "openrouter",
] as const;
export type ProviderType = (typeof PROVIDERS)[number];

export function isProviderType(p: unknown): p is ProviderType {
  return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

export interface ModelProviderConfig {
  readonly provider: ProviderType;
  readonly model: string;
  readonly tokenRatio?: number;
}

export type ModelTier = string;

export interface SystemRolesConfig {
  readonly planner: ModelProviderConfig;
  readonly executorTiers: readonly ModelProviderConfig[]; // Tiered ladder for execution
  readonly auditor: ModelProviderConfig;
  readonly auditorTiers: readonly ModelProviderConfig[]; // Tiered escalation ladder for the compliance-audit operation (Issue 81)
  readonly auditorPool: readonly ModelProviderConfig[]; // Round-robin rotation pool for the general auditor role (Issue 79)
  readonly reviewer: ModelProviderConfig;
}

export const KNOWN_MODELS_CONFIG: readonly ModelProviderConfig[] = [
  { provider: "gemini", model: "gemini-3.1-flash-lite", tokenRatio: 3.5 },
  { provider: "gemini", model: "gemini-3.5-flash", tokenRatio: 3.5 },
  { provider: "gemini", model: "gemini-3.1-pro-preview", tokenRatio: 3.0 },
  { provider: "anthropic", model: "claude-3-5-sonnet", tokenRatio: 1.0 },
  { provider: "anthropic", model: "claude-3-haiku", tokenRatio: 1.2 },
  { provider: "openai", model: "gpt-4o", tokenRatio: 1.0 },
  { provider: "openai", model: "gpt-4o-mini", tokenRatio: 1.5 },
  { provider: "local", model: "llama3:8b", tokenRatio: 1.0 },
  { provider: "openrouter", model: "z-ai/glm-5.2", tokenRatio: 1.3 },
  { provider: "openrouter", model: "z-ai/glm-5.3-flash", tokenRatio: 1.5 },
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", tokenRatio: 1.0 },
  { provider: "openrouter", model: "deepseek/deepseek-v4-flash", tokenRatio: 1.3 },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it", tokenRatio: 1.0 },
  { provider: "openrouter", model: "minimax/minimax-m3", tokenRatio: 1.0 },
  { provider: "openrouter", model: "xiaomi/mimo-v2.5", tokenRatio: 1.2 },
  { provider: "openrouter", model: "xiaomi/mimo-v2.5-pro", tokenRatio: 1.0 },
  { provider: "openrouter", model: "qwen/qwen3.6-35b-a3b", tokenRatio: 1.2 },
  { provider: "copilot-native", model: "copilot-default", tokenRatio: 1.0 },
  
];

/**
 * Look up a configured planner model in KNOWN_MODELS_CONFIG to resolve
 * its defined tokenRatio. Returns the ratio if found, undefined otherwise.
 */
function resolvePlannerTokenRatio(): number | undefined {
  const plannerModel =
    typeof process !== "undefined"
      ? process.env?.PLANNER_MODEL
      : undefined;
  if (!plannerModel) return undefined;
  const exact = KNOWN_MODELS_CONFIG.find((c) => c.model === plannerModel);
  if (exact) return exact.tokenRatio;

  const partialCandidates = KNOWN_MODELS_CONFIG.filter((c) => plannerModel.includes(c.model));
  if (partialCandidates.length > 0) {
    partialCandidates.sort((a, b) => b.model.length - a.model.length);
    return partialCandidates[0]!.tokenRatio;
  }
  return undefined;
}

export const DEFAULT_ROLES_CONFIG: SystemRolesConfig = {
  get planner() {
    return {
      provider:
        (typeof process !== "undefined" &&
          (isProviderType(process.env?.PLANNER_PROVIDER) ? process.env?.PLANNER_PROVIDER : undefined)) ||
        "gemini",
      model:
        (typeof process !== "undefined" && process.env?.PLANNER_MODEL) ||
        "gemini-3.1-flash-lite",
      tokenRatio:
        typeof process !== "undefined" && process.env?.PLANNER_TOKEN_RATIO
          ? parseFloat(process.env.PLANNER_TOKEN_RATIO)
          : (resolvePlannerTokenRatio() ?? 3.5),
    };
  },
  get executorTiers() {
    return [
      {
        provider:
          (typeof process !== "undefined" &&
            (isProviderType(process.env?.EXECUTOR_TIER_0_PROVIDER) ? process.env?.EXECUTOR_TIER_0_PROVIDER : undefined)) ||
          "gemini",
        model:
          (typeof process !== "undefined" &&
            process.env?.EXECUTOR_TIER_0_MODEL) ||
          "gemini-3.1-flash-lite",
        tokenRatio: 3.5,
      },
      {
        provider:
          (typeof process !== "undefined" &&
            (isProviderType(process.env?.EXECUTOR_TIER_1_PROVIDER) ? process.env?.EXECUTOR_TIER_1_PROVIDER : undefined)) ||
          "gemini",
        model:
          (typeof process !== "undefined" &&
            process.env?.EXECUTOR_TIER_1_MODEL) ||
          "gemini-3.5-flash",
        tokenRatio: 3.5,
      },
      {
        provider:
          (typeof process !== "undefined" &&
            (isProviderType(process.env?.EXECUTOR_TIER_2_PROVIDER) ? process.env?.EXECUTOR_TIER_2_PROVIDER : undefined)) ||
          "gemini",
        model:
          (typeof process !== "undefined" &&
            process.env?.EXECUTOR_TIER_2_MODEL) ||
          "gemini-3.1-pro-preview",
        tokenRatio: 3.0,
      },
    ];
  },
  get auditor() {
    return {
      provider:
        (typeof process !== "undefined" &&
          (isProviderType(process.env?.AUDITOR_PROVIDER) ? process.env?.AUDITOR_PROVIDER : undefined)) ||
        "gemini",
      model:
        (typeof process !== "undefined" && process.env?.AUDITOR_MODEL) ||
        "gemini-3.1-flash-lite",
      tokenRatio: 3.5,
    };
  },
  /**
   * Tiered escalation ladder for auditor roles (Issue 81 / RM-REQ-021):
   * mirrors executorTiers' shape so compliance-audit re-runs can escalate to
   * a stronger model when repeated audits keep finding issues after a full
   * remediation cycle. Tier 0 intentionally matches the `auditor` getter
   * above (including its AUDITOR_PROVIDER/AUDITOR_MODEL env override) so
   * existing single-tier auditor configuration keeps working unchanged.
   */
  get auditorTiers(): readonly ModelProviderConfig[] {
    return [
      this.auditor,
      {
        provider:
          (typeof process !== "undefined" &&
            (isProviderType(process.env?.AUDITOR_TIER_1_PROVIDER) ? process.env?.AUDITOR_TIER_1_PROVIDER : undefined)) ||
          "gemini",
        model:
          (typeof process !== "undefined" && process.env?.AUDITOR_TIER_1_MODEL) ||
          "gemini-3.5-flash",
        tokenRatio: 3.5,
      },
      {
        provider:
          (typeof process !== "undefined" &&
            (isProviderType(process.env?.AUDITOR_TIER_2_PROVIDER) ? process.env?.AUDITOR_TIER_2_PROVIDER : undefined)) ||
          "gemini",
        model:
          (typeof process !== "undefined" && process.env?.AUDITOR_TIER_2_MODEL) ||
          "gemini-3.1-pro-preview",
        tokenRatio: 3.0,
      },
    ];
  },
  /**
   * Round-robin rotation pool for the general auditor role (Issue 79 /
   * RM-REQ-030/031/032/033). Configured via a single `AUDITOR_POOL` env var
   * of comma-separated `provider:model` entries, e.g.
   * `AUDITOR_POOL=gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash`.
   * Falls back to a single-entry pool (this.auditor) when unset -- this is
   * deliberately a single-model pool by default so the "single-model pool"
   * warning (RM-REQ-032) surfaces until an operator opts into a real pool,
   * rather than silently picking a diverse default nobody asked for.
   *
   * This pool is entirely independent of auditorTiers above: auditorTiers
   * is the compliance-audit operation's own escalation ladder (Issue 81)
   * and must not be conflated with this rotation pool (RM-REQ-033).
   */
  get auditorPool(): readonly ModelProviderConfig[] {
    const raw = typeof process !== "undefined" ? process.env?.AUDITOR_POOL : undefined;
    const parsed = parseAuditorPoolEnv(raw);
    return parsed && parsed.length > 0 ? parsed : [this.auditor];
  },
  get reviewer() {
    return {
      provider:
        (typeof process !== "undefined" &&
          (isProviderType(process.env?.REVIEWER_PROVIDER) ? process.env?.REVIEWER_PROVIDER : undefined)) ||
        "gemini",
      model:
        (typeof process !== "undefined" && process.env?.REVIEWER_MODEL) ||
        "gemini-3.1-pro-preview",
      tokenRatio: 3.0,
    };
  },
};

export const MODEL_TIERS: readonly string[] = Array.from(
  new Set(DEFAULT_ROLES_CONFIG.executorTiers.map((t) => t.model)),
);

export function getExecutorTier(tierIndex: number): ModelProviderConfig {
  const tiers = DEFAULT_ROLES_CONFIG.executorTiers;
  if (tiers.length === 0) {
    throw new Error("No executor tiers defined");
  }
  if (tierIndex >= tiers.length) {
    return tiers[tiers.length - 1]!; // Assert not-undefined
  }
  return tiers[tierIndex]!;
}

export function getNextTier(model: string): string | null {
  const index = MODEL_TIERS.indexOf(model);
  if (index === -1 || index >= MODEL_TIERS.length - 1) {
    return null;
  }
  return MODEL_TIERS[index + 1] || null;
}

/**
 * Index-based accessor for the auditor tier ladder (Issue 81 / RM-REQ-021).
 * Clamps to the highest configured tier rather than throwing, mirroring
 * getExecutorTier's clamping behavior -- callers track tier progress by
 * index (persisted on the PBI record), not by model name.
 */
export function getAuditorTierConfig(tierIndex: number): ModelProviderConfig {
  const tiers = DEFAULT_ROLES_CONFIG.auditorTiers;
  if (tiers.length === 0) {
    throw new Error("No auditor tiers defined");
  }
  if (tierIndex < 0) {
    return tiers[0]!;
  }
  if (tierIndex >= tiers.length) {
    return tiers[tiers.length - 1]!;
  }
  return tiers[tierIndex]!;
}

/** Highest valid auditor tier index -- reaching this and still failing is a terminal escalation (RM-REQ-022). */
export function getAuditorMaxTierIndex(): number {
  return DEFAULT_ROLES_CONFIG.auditorTiers.length - 1;
}

/**
 * Parses the `AUDITOR_POOL` env var into a list of ModelProviderConfig
 * entries (Issue 79 / RM-REQ-030). Expected format is comma-separated
 * `provider:model` pairs, e.g.
 * `"gemini:gemini-3.1-flash-lite,openai:gpt-4o-mini"`.
 * Returns `null` (not an empty array) when `raw` is unset/blank so callers
 * can distinguish "not configured" from "configured but empty" and fall
 * back appropriately. Malformed entries (missing `:`, unknown provider) are
 * skipped with a console warning rather than throwing, so a single typo in
 * a long pool string doesn't take down the whole system.
 */
export function parseAuditorPoolEnv(raw: string | undefined): ModelProviderConfig[] | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const pool: ModelProviderConfig[] = [];
  for (const entry of entries) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex === -1) {
      console.warn(`[AUDITOR_POOL] Skipping malformed entry (expected "provider:model"): "${entry}"`);
      continue;
    }
    const provider = entry.slice(0, separatorIndex).trim();
    const model = entry.slice(separatorIndex + 1).trim();
    if (!isProviderType(provider) || !model) {
      console.warn(`[AUDITOR_POOL] Skipping malformed entry (unknown provider or empty model): "${entry}"`);
      continue;
    }
    pool.push({ provider, model });
  }
  return pool;
}

/**
 * Deterministic round-robin selection from the auditor pool (RM-REQ-031):
 * `rotationIndex` is expected to be a monotonically increasing counter
 * persisted in session state (see StateSnapshot.auditorRotationIndex) --
 * this function itself is pure and does not mutate or persist anything.
 * Negative indices wrap correctly (rather than throwing) purely as a
 * defensive measure; callers should never pass a negative rotationIndex.
 */
export function selectFromAuditorPool(rotationIndex: number): ModelProviderConfig {
  const pool = DEFAULT_ROLES_CONFIG.auditorPool;
  if (pool.length === 0) {
    throw new Error("Auditor pool is empty");
  }
  const normalizedIndex = ((rotationIndex % pool.length) + pool.length) % pool.length;
  return pool[normalizedIndex]!;
}
