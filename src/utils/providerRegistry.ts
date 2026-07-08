import { MODEL_TIERS, DEFAULT_ROLES_CONFIG, KNOWN_MODELS_CONFIG, ModelProviderConfig, ProviderType } from '../config/models';

export interface ProviderConfig {
  type: 'openai' | 'anthropic' | 'azure';
  baseUrl: string;
  apiKey?: string;
  wireApi?: 'completions' | 'responses';
}

export interface ExecutionConfig {
  model: string;
  providerType: ProviderType;
  provider?: ProviderConfig;
}

export class ProviderRegistry {
  private apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  /**
   * Helper to map raw model names to official model identifiers.
   * This replaces structural dependencies on raw hardcoded mappings or fallbacks
   * in server.ts.
   */
  public getMappedModel(modelName?: string): string {
    if (!modelName) {
      return MODEL_TIERS[0] || 'gemini-3.1-flash-lite';
    }
    const cleaned = modelName.replace('models/', '').trim();
    // Return custom provider-namespaced paths early (e.g. openrouter paths) to avoid incorrect partial matching/collapsing
    if (cleaned.includes('/')) {
      return cleaned;
    }

    // Prefer exact matches then longest partial match to avoid substring collisions (e.g. gpt-4o vs gpt-4o-mini)
    const exact = MODEL_TIERS.find(m => m === cleaned);
    if (exact) return exact;

    const partialCandidates = MODEL_TIERS.filter(m => m.includes(cleaned) || cleaned.includes(m));
    if (partialCandidates.length > 0) {
      partialCandidates.sort((a, b) => b.length - a.length);
      return partialCandidates[0]!;
    }

    if (DEFAULT_ROLES_CONFIG.planner.model === cleaned || DEFAULT_ROLES_CONFIG.planner.model.includes(cleaned)) {
      return DEFAULT_ROLES_CONFIG.planner.model;
    }
    if (DEFAULT_ROLES_CONFIG.auditor.model === cleaned || DEFAULT_ROLES_CONFIG.auditor.model.includes(cleaned)) {
      return DEFAULT_ROLES_CONFIG.auditor.model;
    }

    return MODEL_TIERS[0] || 'gemini-3.1-flash-lite';
  }

  /**
   * Resolves the provider type for a given model or config, without retrieving or validating API keys.
   */
  public getProviderType(input: string | ModelProviderConfig): ProviderType {
    if (typeof input === 'object' && input !== null) {
      return input.provider;
    }
    const model = this.getMappedModel(input as string);
    const allConfigs = [
      DEFAULT_ROLES_CONFIG.planner,
      DEFAULT_ROLES_CONFIG.auditor,
      ...DEFAULT_ROLES_CONFIG.executorTiers,
      ...KNOWN_MODELS_CONFIG
    ];

    let matchedConfig = allConfigs.find(t => t.model === model);

    if (!matchedConfig) {
      const candidates = allConfigs.filter(t => model.includes(t.model) || t.model.includes(model));
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.model.length - a.model.length);
        matchedConfig = candidates[0];
      }
    }

    if (matchedConfig) {
      return matchedConfig.provider;
    } else if (model.includes('/')) {
      return 'openrouter';
    } else {
      return 'gemini';
    }
  }

  /**
   * Retrieves the specific ProviderConfig block for the given model.
   */
  public getProviderConfig(provider: ProviderType, modelName: string): ProviderConfig | undefined {
    if (provider === 'copilot-native') {
      return undefined;
    }

    if (process.env.COPILOT_API_URL) {
      if (provider === 'openai' || process.env.VITEST === 'true') {
        return {
          type: 'openai',
          baseUrl: process.env.COPILOT_API_URL,
          apiKey: this.apiKey || 'mock-key'
        };
      }
    }

    if (provider === 'gemini') {
      if (!this.apiKey) {
        throw new Error('Missing API key for Gemini provider. Expected GEMINI_API_KEY to be set.');
      }
      return {
        type: 'openai',
        baseUrl: process.env.COPILOT_API_URL ? `${process.env.COPILOT_API_URL}/api/providers/gemini/v1beta/openai/` : `http://localhost:${process.env.PORT || 3000}/api/providers/gemini/v1beta/openai/`,
        apiKey: this.apiKey
      };
    } else if (provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for Anthropic provider. Expected ANTHROPIC_API_KEY to be set.');
      }
      return {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/',
        apiKey
      };
    } else if (provider === 'local') {
      return {
        type: 'openai',
        baseUrl: process.env.LOCAL_PROVIDER_URL || 'http://127.0.0.1:11434/v1/',
        apiKey: process.env.LOCAL_PROVIDER_API_KEY || 'ollama'
      };
    } else if (provider === 'openrouter') {
      // Support OpenRouter API key env var without GEMINI_API_KEY fallback to avoid silent failure
      const apiKey = process.env.OPENROUTER_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for OpenRouter provider. Expected OPENROUTER_API_KEY to be set.');
      }


      const proxyBaseUrl = process.env.COPILOT_API_URL ? `${process.env.COPILOT_API_URL}/api/providers/openrouter/api/v1/` : `http://localhost:${process.env.PORT || 3000}/api/providers/openrouter/api/v1/`;
      let finalBaseUrl = process.env.OPENROUTER_BASE_URL || proxyBaseUrl;
      if (finalBaseUrl) {
        finalBaseUrl = finalBaseUrl.trim();
        finalBaseUrl = finalBaseUrl.replace(/\/chat\/completions\/?$/, '/');
        finalBaseUrl = finalBaseUrl.replace(/\/completions\/?$/, '/');
        if (!finalBaseUrl.endsWith('/')) {
          finalBaseUrl += '/';
        }
      }
      return {
        type: 'openai',
        // default known endpoint for OpenRouter; allow override via OPENROUTER_BASE_URL if needed
        baseUrl: finalBaseUrl,
        apiKey
      };
    } else if (provider === 'openai') {
      if (process.env.COPILOT_API_URL) {
        return {
          type: 'openai',
          baseUrl: process.env.COPILOT_API_URL,
          apiKey: this.apiKey || 'mock-key'
        };
      }
      const apiKey = process.env.OPENAI_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for OpenAI provider. Expected OPENAI_API_KEY to be set.');
      }
      return {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1/',
        apiKey
      };
    }

    return undefined;
  }

  /**
   * Resolves the entire ExecutionConfig (model execution identity and provider connection variables)
   * exclusively from the registry instance.
   */
  public getExecutionConfig(input: string | ModelProviderConfig): ExecutionConfig {
    let providerType: ProviderType = 'gemini';
    let model: string;

    if (typeof input === 'object' && input !== null) {
      providerType = input.provider;
      model = this.getMappedModel(input.model);
    } else {
      model = this.getMappedModel(input as string);
      // Look up model in all configs to find its configured provider.
      // Prefer exact matches. If none, pick the longest partial match to avoid shorter substrings shadowing longer models.
      const allConfigs = [
        DEFAULT_ROLES_CONFIG.planner,
        DEFAULT_ROLES_CONFIG.auditor,
        ...DEFAULT_ROLES_CONFIG.executorTiers,
        ...KNOWN_MODELS_CONFIG
      ];

      // exact match first
      let matchedConfig = allConfigs.find(t => t.model === model);

      if (!matchedConfig) {
        // candidates where either side contains the other
        const candidates = allConfigs.filter(t => model.includes(t.model) || t.model.includes(model));
        if (candidates.length > 0) {
          // choose the candidate with the longest model string to prefer more-specific variants
          candidates.sort((a, b) => b.model.length - a.model.length);
          matchedConfig = candidates[0];
        }
      }

      if (matchedConfig) {
        providerType = matchedConfig.provider;
      } else if (model.includes('/')) {
        providerType = 'openrouter';
      } else {
        providerType = 'gemini';
      }
    }

    const provider = this.getProviderConfig(providerType, model);
    return {
      model,
      providerType,
      provider
    };
  }

  // Classic static helper for backward compatibility
  static getProviderConfig(provider: ProviderType, modelName: string, apiKey: string): ProviderConfig | undefined {
    return new ProviderRegistry(apiKey).getProviderConfig(provider, modelName);
  }
}
