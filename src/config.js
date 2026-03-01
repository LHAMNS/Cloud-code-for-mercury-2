// Mercury Code - Configuration
// Based on Mercury-2 diffusion model from Inception Labs

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

export function getApiKey() {
  const key = process.env.INCEPTION_API_KEY;
  if (!key) {
    throw new Error(
      "INCEPTION_API_KEY environment variable is required.\n" +
        "Get your API key from https://api.inceptionlabs.ai and set it:\n" +
        "  export INCEPTION_API_KEY=your_key_here"
    );
  }
  return key;
}
