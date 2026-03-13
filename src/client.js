// Mercury Code - API Client
// Handles communication with AI providers (Mercury-2, OpenAI, etc.) via OpenAI-compatible API

import { MERCURY_API_BASE, normalizeClientConfig, getApiKey } from "./config.js";
import { getProvider, getDefaultProvider } from "./providers.js";
import https from "node:https";
import http from "node:http";

// ── Retry configuration ───────────────────────────────────────────────────────
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_NETWORK_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"]);

function _isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export class MercuryClient {
  constructor(options = {}) {
    // Provider: determines baseURL, API key env var, and capability flags.
    this._providerName = options.provider || "mercury";
    this._provider = getProvider(this._providerName) || getDefaultProvider();

    // Store explicitly-provided key; otherwise read from env on each use
    // to reduce exposure window in memory dumps.
    this._explicitApiKey = options.apiKey || null;
    this.baseURL = options.baseURL || this._provider.baseURL || MERCURY_API_BASE;
    this.config = normalizeClientConfig(options, this._providerName);
    this._httpWarned = false;
    this.allowInsecureHttp = options.allowInsecureHttp === true;
  }

  /**
   * Get the current provider name.
   */
  get providerName() {
    return this._providerName;
  }

  /**
   * Get the current provider definition.
   */
  get provider() {
    return this._provider;
  }

  /**
   * Switch to a different provider at runtime.
   * Updates baseURL, API key resolution, and capabilities.
   * @param {string} providerName - New provider name
   * @param {object} [opts] - Optional overrides { apiKey, baseURL, model }
   */
  switchProvider(providerName, opts = {}) {
    const provider = getProvider(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    this._providerName = providerName;
    this._provider = provider;
    this.baseURL = opts.baseURL || provider.baseURL || process.env.MERCURY_API_BASE || "https://api.inceptionlabs.ai/v1";
    if (opts.apiKey) this._explicitApiKey = opts.apiKey;
    if (opts.model) {
      this.config.model = opts.model;
    } else {
      this.config.model = provider.defaultModel;
    }
    // Re-normalize config with new provider limits
    this.config = normalizeClientConfig(this.config, providerName);
  }

  /**
   * Get the API key — prefer explicitly-set key, fall back to env var.
   * Reading from env on demand minimizes time the key sits in object properties.
   */
  get apiKey() {
    return this._explicitApiKey || getApiKey(this._providerName);
  }

  set apiKey(value) {
    this._explicitApiKey = value || null;
  }

  /**
   * Reject plain-HTTP requests that carry an API key (unless opted-in via env).
   * Throws an error to prevent credentials from leaking over unencrypted connections.
   * Set MERCURY_ALLOW_HTTP=1 to bypass for local development/testing.
   */
  _warnIfInsecure() {
    if (this._httpWarned) return;
    try {
      const parsed = new URL(this.baseURL);
      if (parsed.protocol === "http:" && this.apiKey) {
        if (_isLoopbackHost(parsed.hostname)) {
          return;
        }
        if (this.allowInsecureHttp || process.env.MERCURY_ALLOW_HTTP === "1") {
          process.stderr.write(
            "[mercury] WARNING: API key is being sent over plain HTTP. " +
            "Use HTTPS to protect credentials in transit.\n"
          );
          this._httpWarned = true;
          return;
        }
        throw new Error(
          "[mercury] Refusing to send API key over plain HTTP. " +
          "Use HTTPS or set MERCURY_ALLOW_HTTP=1 to override."
        );
      }
    } catch (e) {
      // Re-throw our own security error; swallow only URL parse failures.
      if (e.message && e.message.startsWith("[mercury]")) throw e;
      // malformed URL — will fail later in _fetch
    }
  }

  /**
   * Send a non-streaming chat completion request (with automatic retry).
   */
  async chatCompletion(messages, options = {}) {
    this._warnIfInsecure();
    const body = this._buildRequestBody(messages, options);
    body.stream = false;
    return await this._fetchWithRetry("/chat/completions", body);
  }

  /**
   * Send a streaming chat completion request.
   * Yields parsed SSE chunk objects in real-time as they arrive.
   * Retries only during the connection phase (before data starts flowing),
   * not once data is being received.
   */
  async *chatCompletionStream(messages, options = {}) {
    this._warnIfInsecure();
    const body = this._buildRequestBody(messages, options);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const parsed = new URL(this.baseURL);
    parsed.pathname = parsed.pathname.replace(/\/$/, '') + "/chat/completions";
    const url = parsed;
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const requestBody = JSON.stringify(body);

    // Connection-phase retry: retry on network errors or retryable status codes
    // before any data has been yielded to the caller.
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // We use a simple queue + Promise-based async iterator so chunks are
      // yielded to the caller the instant they arrive from the network.
      const queue = [];
      let resolve = null;
      let done = false;
      let error = null;
      let connectionEstablished = false;

      function enqueue(value) {
        connectionEstablished = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r({ value, done: false });
        } else {
          queue.push(value);
        }
      }

      function finish(err) {
        done = true;
        error = err || null;
        if (resolve) {
          const r = resolve;
          resolve = null;
          if (err) r({ value: undefined, done: true, error: err });
          else r({ value: undefined, done: true });
        }
      }

      let connectionError = null;
      let retryableConnectionError = false;

      const req = lib.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
          timeout: 120000, // 2 minute connection timeout
        },
        (res) => {
          // Check for retryable status codes at connection phase
          if (res.statusCode !== 200) {
            if (RETRYABLE_STATUS.has(res.statusCode) && attempt < MAX_RETRIES) {
              retryableConnectionError = true;
              let errBody = "";
              const MAX_ERR_BODY = 1024 * 1024; // 1MB
              res.on("data", (d) => {
                if (errBody.length < MAX_ERR_BODY) errBody += d.toString();
              });
              res.on("end", () => {
                connectionError = new Error(`Mercury API error (${res.statusCode}): ${errBody}`);
                connectionError.statusCode = res.statusCode;
                finish(connectionError);
              });
              return;
            }
            let errBody = "";
            const MAX_ERR_BODY2 = 1024 * 1024; // 1MB
            res.on("data", (d) => {
              if (errBody.length < MAX_ERR_BODY2) errBody += d.toString();
            });
            res.on("end", () =>
              finish(new Error(`Mercury API error (${res.statusCode}): ${errBody}`))
            );
            return;
          }

          let buffer = "";
          res.on("data", (chunk) => {
            // Reset inactivity timer on every chunk
            if (inactivityTimer) {
              clearTimeout(inactivityTimer);
              inactivityTimer = setTimeout(() => {
                req.destroy(new Error("Stream inactivity timeout (120s since last chunk)"));
              }, INACTIVITY_TIMEOUT);
            }
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);
              if (data === "[DONE]") continue;
              try {
                enqueue(JSON.parse(data));
              } catch {
                // skip malformed chunks
              }
            }
          });

          res.on("end", () => {
            // Process any remaining buffer
            if (buffer.trim()) {
              const trimmed = buffer.trim();
              if (
                trimmed.startsWith("data: ") &&
                trimmed.slice(6) !== "[DONE]"
              ) {
                try {
                  enqueue(JSON.parse(trimmed.slice(6)));
                } catch {
                  // skip
                }
              }
            }
            finish();
          });
        }
      );

      req.on("error", (err) => {
        if (!connectionEstablished && attempt < MAX_RETRIES && RETRYABLE_NETWORK_ERRORS.has(err.code)) {
          retryableConnectionError = true;
          connectionError = err;
        }
        finish(err);
      });
      req.on("timeout", () => {
        req.destroy(new Error("Request timed out (120s)"));
      });

      // Inactivity timeout: destroy if no data received for 120s
      const INACTIVITY_TIMEOUT = 120000;
      let inactivityTimer = setTimeout(() => {
        req.destroy(new Error("Stream inactivity timeout (120s since last chunk)"));
      }, INACTIVITY_TIMEOUT);
      const _origFinish = finish;
      finish = function finishWithTimer(err) {
        clearTimeout(inactivityTimer);
        _origFinish(err);
      };

      req.write(requestBody);
      req.end();

      // Wait until connection is established or fails
      // If the connection fails with a retryable error, continue to next attempt
      if (!done && !connectionEstablished) {
        const firstResult = await new Promise((r) => {
          resolve = r;
        });
        if (firstResult.done && retryableConnectionError) {
          lastError = connectionError || firstResult.error;
          req.destroy();
          continue; // retry
        }
        // Connection succeeded or non-retryable error
        if (firstResult.done) {
          if (firstResult.error) throw firstResult.error;
          return;
        }
        yield firstResult.value;
      } else if (done && retryableConnectionError) {
        lastError = connectionError || error;
        req.destroy();
        continue; // retry
      } else if (done) {
        if (error) throw error;
        return;
      }

      // Connection established — stream data without retrying
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
          } else if (done) {
            if (error) throw error;
            return;
          } else {
            const result = await new Promise((r) => {
              resolve = r;
            });
            if (result.done) {
              if (result.error) throw result.error;
              return;
            }
            yield result.value;
          }
        }
      } finally {
        // Ensure the request is destroyed if the consumer stops early
        req.destroy();
      }
    }

    // All retries exhausted
    if (lastError) throw lastError;
  }

  /**
   * Build the request body for Mercury-2.
   */
  _buildRequestBody(messages, options = {}) {
    // Sanitize messages: ensure content is a string where required.
    // Assistant messages with tool_calls legitimately have content: null per OpenAI spec.
    const sanitized = messages.map((msg) => {
      const m = { ...msg };
      if (m.role === "assistant" && m.tool_calls) {
        // Keep content as-is (null is valid for assistant + tool_calls)
      } else if (m.content === null || m.content === undefined) {
        m.content = "";
      }
      return m;
    });

    const provider = this._provider;

    const body = {
      model: options.model || this.config.model,
      messages: sanitized,
      max_tokens: options.max_tokens ?? this.config.max_tokens,
      temperature: options.temperature ?? this.config.temperature,
    };

    // Provider-specific fields: only include if the provider supports them
    if (provider.supportsReasoning) {
      body.reasoning_effort = options.reasoning_effort ?? this.config.reasoning_effort;
    }
    if (provider.supportsReasoningSummary) {
      body.reasoning_summary = options.reasoning_summary ?? this.config.reasoning_summary;
    }

    if (options.stop) body.stop = options.stop;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;

    // Diffusing is Mercury-specific
    if (provider.supportsDiffusing && options.diffusing) {
      body.diffusing = true;
      body.stream = true;
    }

    return body;
  }

  /**
   * Make a non-streaming POST request to the API.
   * Returns { statusCode, body } for retry logic, or resolves with parsed JSON on success.
   */
  _fetch(endpoint, body) {
    const parsedUrl = new URL(this.baseURL);
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/$/, '') + endpoint;
    const requestBody = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const req = lib.request(
        {
          method: "POST",
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
          timeout: 120000, // 2 minute connection timeout
        },
        (res) => {
          let data = "";
          const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB
          res.on("data", (chunk) => {
            data += chunk.toString();
            if (data.length > MAX_RESPONSE_SIZE) {
              res.destroy(new Error("Response too large"));
            }
          });
          res.on("end", () => {
            // For retryable status codes, resolve with status info instead of rejecting
            if (RETRYABLE_STATUS.has(res.statusCode)) {
              const err = new Error(
                `Mercury API error (${res.statusCode}): ${data.slice(0, 500)}`
              );
              err.statusCode = res.statusCode;
              reject(err);
              return;
            }
            try {
              const json = JSON.parse(data);
              if (res.statusCode !== 200) {
                reject(
                  new Error(
                    `Mercury API error (${res.statusCode}): ${JSON.stringify(json)}`
                  )
                );
              } else {
                resolve(json);
              }
            } catch {
              reject(
                new Error(`Invalid JSON response: ${data.slice(0, 500)}`)
              );
            }
          });
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Request timed out (120s)"));
      });
      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Fetch with exponential backoff retry for transient errors.
   * Retries on: 429, 500, 502, 503, 504 status codes and
   * ECONNRESET, ETIMEDOUT, ECONNREFUSED network errors.
   */
  async _fetchWithRetry(endpoint, body, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._fetch(endpoint, body);
      } catch (err) {
        const isRetryableStatus = err.statusCode && RETRYABLE_STATUS.has(err.statusCode);
        const isRetryableNetwork = RETRYABLE_NETWORK_ERRORS.has(err.code);

        if (attempt < retries && (isRetryableStatus || isRetryableNetwork)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
  }
}
