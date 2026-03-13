// Mercury Code - Provider Registry
// Manages multiple AI API providers (Mercury-2, OpenAI, etc.)
// Each provider defines: baseURL, API key env var, model catalog, and capabilities.

// ── Provider Definitions ────────────────────────────────────────────────────

const PROVIDERS = {
  mercury: {
    name: "mercury",
    displayName: "Mercury-2 (Inception Labs)",
    baseURL: "https://api.inceptionlabs.ai/v1",
    envKey: "INCEPTION_API_KEY",
    defaultModel: "mercury-2",
    models: {
      "mercury-2": {
        maxContext: 128000,
        maxOutput: 50000,
        tempRange: [0.5, 1.0],
        description: "Mercury-2 diffusion model",
      },
    },
    supportsReasoning: true,
    supportsDiffusing: true,
    supportsReasoningSummary: true,
  },

  openai: {
    name: "openai",
    displayName: "OpenAI (ChatGPT)",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    models: {
      // ── GPT-4o family ──
      "gpt-4o": {
        maxContext: 128000,
        maxOutput: 16384,
        tempRange: [0, 2],
        description: "GPT-4o — flagship multimodal model",
      },
      "gpt-4o-mini": {
        maxContext: 128000,
        maxOutput: 16384,
        tempRange: [0, 2],
        description: "GPT-4o mini — cost-effective",
      },
      // ── GPT-4.1 family ──
      "gpt-4.1": {
        maxContext: 1047576,
        maxOutput: 32768,
        tempRange: [0, 2],
        description: "GPT-4.1 — long-context coding model",
      },
      "gpt-4.1-mini": {
        maxContext: 1047576,
        maxOutput: 32768,
        tempRange: [0, 2],
        description: "GPT-4.1 mini — fast + long context",
      },
      "gpt-4.1-nano": {
        maxContext: 1047576,
        maxOutput: 32768,
        tempRange: [0, 2],
        description: "GPT-4.1 nano — ultrafast + cheapest",
      },
      // ── o-series reasoning models ──
      "o3": {
        maxContext: 200000,
        maxOutput: 100000,
        tempRange: [1, 1],
        description: "o3 — advanced reasoning model",
        reasoningModel: true,
      },
      "o4-mini": {
        maxContext: 200000,
        maxOutput: 100000,
        tempRange: [1, 1],
        description: "o4-mini — fast reasoning model",
        reasoningModel: true,
      },
      // ── GPT-4 Turbo ──
      "gpt-4-turbo": {
        maxContext: 128000,
        maxOutput: 4096,
        tempRange: [0, 2],
        description: "GPT-4 Turbo — legacy high-intelligence",
      },
      // ── GPT-3.5 ──
      "gpt-3.5-turbo": {
        maxContext: 16384,
        maxOutput: 4096,
        tempRange: [0, 2],
        description: "GPT-3.5 Turbo — fast & budget",
      },
    },
    supportsReasoning: false,
    supportsDiffusing: false,
    supportsReasoningSummary: false,
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a provider definition by name.
 * @param {string} name - Provider name (e.g., "mercury", "openai")
 * @returns {object|null} Provider definition or null if not found
 */
export function getProvider(name) {
  return PROVIDERS[name] || null;
}

/**
 * Get the default (Mercury) provider.
 * @returns {object} Mercury provider definition
 */
export function getDefaultProvider() {
  return PROVIDERS.mercury;
}

/**
 * List all registered provider names.
 * @returns {string[]} Array of provider names
 */
export function listProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * List all providers with their display names and available models.
 * @returns {Array<{name: string, displayName: string, models: string[]}>}
 */
export function listProvidersDetailed() {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    displayName: p.displayName,
    defaultModel: p.defaultModel,
    models: Object.entries(p.models).map(([id, info]) => ({
      id,
      description: info.description || id,
      maxContext: info.maxContext,
      maxOutput: info.maxOutput,
    })),
  }));
}

/**
 * Determine which provider a model belongs to.
 * Searches all providers for the model name.
 * @param {string} modelName - Model identifier
 * @returns {object|null} Provider definition or null
 */
export function getProviderForModel(modelName) {
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.models[modelName]) {
      return provider;
    }
  }
  return null;
}

/**
 * Get model limits for a specific model within a provider.
 * Returns the default limits if model is not found in the catalog.
 * @param {string} providerName - Provider name
 * @param {string} modelName - Model identifier
 * @returns {object} { maxContext, maxOutput, tempRange }
 */
export function getModelLimits(providerName, modelName) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return { maxContext: 128000, maxOutput: 16384, tempRange: [0, 2] };
  }
  const model = provider.models[modelName];
  if (model) {
    return {
      maxContext: model.maxContext,
      maxOutput: model.maxOutput,
      tempRange: model.tempRange,
    };
  }
  // Fallback for unknown models within a known provider
  return { maxContext: 128000, maxOutput: 16384, tempRange: [0, 2] };
}

/**
 * Get the API key for a provider from environment variables.
 * @param {string} providerName - Provider name
 * @returns {string|null} API key or null
 */
export function getProviderApiKey(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return null;
  return process.env[provider.envKey] || null;
}

/**
 * Register a custom provider at runtime.
 * Allows users to add their own OpenAI-compatible endpoints.
 * @param {object} providerDef - Provider definition object
 */
export function registerProvider(providerDef) {
  if (!providerDef.name || !providerDef.baseURL) {
    throw new Error("Provider must have a name and baseURL");
  }
  const filtered = Object.fromEntries(Object.entries(providerDef).filter(([, v]) => v !== undefined));
  PROVIDERS[providerDef.name] = {
    displayName: providerDef.displayName || providerDef.name,
    envKey: providerDef.envKey || `${providerDef.name.toUpperCase()}_API_KEY`,
    defaultModel: providerDef.defaultModel || "default",
    models: providerDef.models || {},
    supportsReasoning: providerDef.supportsReasoning || false,
    supportsDiffusing: providerDef.supportsDiffusing || false,
    supportsReasoningSummary: providerDef.supportsReasoningSummary || false,
    ...filtered,
  };
}
