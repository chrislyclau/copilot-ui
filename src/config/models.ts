export const PROVIDERS = ['copilot-native', 'openai', 'anthropic', 'gemini', 'local'] as const;
export type ProviderType = typeof PROVIDERS[number];

export interface ModelProviderConfig {
  provider: ProviderType;
  model: string;
  tokenRatio?: number;
}

export type ModelTier = string;

export interface SystemRolesConfig {
  planner: ModelProviderConfig;
  executorTiers: ModelProviderConfig[]; // Tiered ladder for execution
  auditor: ModelProviderConfig;
  reviewer: ModelProviderConfig;
}

export const KNOWN_MODELS_CONFIG: ModelProviderConfig[] = [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite', tokenRatio: 3.5 },
  { provider: 'gemini', model: 'gemini-3.5-flash', tokenRatio: 3.5 },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview', tokenRatio: 3.0 },
  { provider: 'anthropic', model: 'claude-3-5-sonnet', tokenRatio: 1.0 },
  { provider: 'anthropic', model: 'claude-3-haiku', tokenRatio: 1.2 },
  { provider: 'openai', model: 'gpt-4o', tokenRatio: 1.0 },
  { provider: 'openai', model: 'gpt-4o-mini', tokenRatio: 1.5 },
  { provider: 'local', model: 'llama3:8b', tokenRatio: 1.0 },
  { provider: 'copilot-native', model: 'copilot-default', tokenRatio: 1.0 },
];

export const DEFAULT_ROLES_CONFIG: SystemRolesConfig = {
  planner: {
    provider: (typeof process !== 'undefined' && process.env?.PLANNER_PROVIDER as ProviderType) || 'gemini',
    model: (typeof process !== 'undefined' && process.env?.PLANNER_MODEL) || 'gemini-3.1-flash-lite',
    tokenRatio: (typeof process !== 'undefined' && process.env?.PLANNER_TOKEN_RATIO ? parseFloat(process.env.PLANNER_TOKEN_RATIO) : 3.5)
  },
  executorTiers: [
    {
      provider: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_0_PROVIDER as ProviderType) || 'gemini',
      model: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_0_MODEL) || 'gemini-3.1-flash-lite',
      tokenRatio: 3.5
    },
    {
      provider: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_1_PROVIDER as ProviderType) || 'gemini',
      model: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_1_MODEL) || 'gemini-3.5-flash',
      tokenRatio: 3.5
    },
    {
      provider: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_2_PROVIDER as ProviderType) || 'gemini',
      model: (typeof process !== 'undefined' && process.env?.EXECUTOR_TIER_2_MODEL) || 'gemini-3.1-pro-preview',
      tokenRatio: 3.0
    }
  ],
  auditor: {
    provider: (typeof process !== 'undefined' && process.env?.AUDITOR_PROVIDER as ProviderType) || 'gemini',
    model: (typeof process !== 'undefined' && process.env?.AUDITOR_MODEL) || 'gemini-3.1-flash-lite',
    tokenRatio: 3.5
  },
  reviewer: {
    provider: (typeof process !== 'undefined' && process.env?.REVIEWER_PROVIDER as ProviderType) || 'gemini',
    model: (typeof process !== 'undefined' && process.env?.REVIEWER_MODEL) || 'gemini-3.1-pro-preview',
    tokenRatio: 3.0
  }
};

export const MODEL_TIERS: string[] = Array.from(new Set(DEFAULT_ROLES_CONFIG.executorTiers.map(t => t.model)));

export function getExecutorTier(tierIndex: number): ModelProviderConfig {
  const tiers = DEFAULT_ROLES_CONFIG.executorTiers;
  if (tiers.length === 0) {
    throw new Error('No executor tiers defined');
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
