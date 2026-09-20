/**
 * Provider-type vocabulary shared by the agentCore package (extraction plan
 * phase 2b). This is the package-side half of the app's src/config/models.ts:
 * the data every consumer (app, UI, scripts) agrees on, moved into the
 * package so agentCore can reference it without a back-edge. Role/tier
 * configuration (DEFAULT_ROLES_CONFIG, KNOWN_MODELS_CONFIG, MODEL_TIERS and
 * the tier/pool helpers) stays app-side; the app re-exports everything here
 * during the transition and injects its role data into ProviderRegistry.
 */

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
