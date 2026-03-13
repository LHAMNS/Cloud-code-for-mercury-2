// Mercury Code - Configuration
// Provider-aware configuration with multi-model support.

import { getProvider, getModelLimits, getProviderApiKey } from "./providers.js";

export const MERCURY_API_BASE =
  process.env.MERCURY_API_BASE || "https://api.inceptionlabs.ai/v1";
export const MERCURY_MODEL = "mercury-2";

export const REASONING_LEVELS = ["instant", "low", "medium", "high"];

export const DEFAULT_CONFIG = {
  model: MERCURY_MODEL,
  max_tokens: 50000,
  temperature: 0.75,
  reasoning_effort: "medium",
  reasoning_summary: true,
  stream: true,
  diffusing: false,
};

export const MODEL_LIMITS = {
  max_context_tokens: 128000,
  max_output_tokens: 50000,
  temperature_range: [0.5, 1.0],
  max_stop_sequences: 4,
};

const CLIENT_CONFIG_KEYS = [
  "model",
  "max_tokens",
  "temperature",
  "reasoning_effort",
  "reasoning_summary",
  "stream",
  "diffusing",
];

/**
 * Normalize client configuration, optionally scoped to a provider.
 * When a providerName is given, uses that provider's model limits.
 * @param {object} config - Raw config object
 * @param {string} [providerName] - Provider name (e.g., "mercury", "openai")
 * @returns {object} Normalized config
 */
export function normalizeClientConfig(config = {}, providerName) {
  const next = { ...DEFAULT_CONFIG };

  for (const key of CLIENT_CONFIG_KEYS) {
    if (config[key] !== undefined) {
      next[key] = config[key];
    }
  }

  // Determine effective limits based on provider + model
  let limits;
  if (providerName) {
    const ml = getModelLimits(providerName, next.model);
    limits = {
      max_output_tokens: ml.maxOutput,
      temperature_range: ml.tempRange,
      max_context_tokens: ml.maxContext,
    };
  } else {
    limits = MODEL_LIMITS;
  }

  if (!REASONING_LEVELS.includes(next.reasoning_effort)) {
    next.reasoning_effort = DEFAULT_CONFIG.reasoning_effort;
  }

  if (typeof next.temperature !== "number" || Number.isNaN(next.temperature)) {
    next.temperature = DEFAULT_CONFIG.temperature;
  }
  next.temperature = Math.min(limits.temperature_range[1], Math.max(limits.temperature_range[0], next.temperature));

  if (!Number.isInteger(next.max_tokens) || next.max_tokens <= 0) {
    next.max_tokens = Math.min(DEFAULT_CONFIG.max_tokens, limits.max_output_tokens);
  }
  next.max_tokens = Math.min(next.max_tokens, limits.max_output_tokens);

  next.reasoning_summary = Boolean(next.reasoning_summary);
  next.stream = Boolean(next.stream);
  next.diffusing = Boolean(next.diffusing);

  return next;
}

/**
 * Get API key — provider-aware.
 * If providerName is given, reads the provider's env var.
 * Falls back to INCEPTION_API_KEY for backward compatibility.
 * @param {string} [providerName] - Provider name
 * @returns {string|null}
 */
export function getApiKey(providerName) {
  if (providerName) {
    const key = getProviderApiKey(providerName);
    if (key) return key;
  }
  // Backward-compatible fallback
  return process.env.INCEPTION_API_KEY || null;
}
