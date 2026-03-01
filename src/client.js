// Mercury Code - API Client
// Handles communication with Mercury-2 via OpenAI-compatible API

import { MERCURY_API_BASE, DEFAULT_CONFIG, getApiKey } from "./config.js";
import https from "node:https";
import http from "node:http";

export class MercuryClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || getApiKey();
    this.baseURL = options.baseURL || MERCURY_API_BASE;
    this.config = { ...DEFAULT_CONFIG, ...options };
  }

  /**
   * Send a non-streaming chat completion request.
   */
  async chatCompletion(messages, options = {}) {
    const body = this._buildRequestBody(messages, options);
    body.stream = false;
    return await this._fetch("/chat/completions", body);
  }

  /**
   * Send a streaming chat completion request.
   * Yields parsed SSE chunk objects in real-time as they arrive.
   */
  async *chatCompletionStream(messages, options = {}) {
    const body = this._buildRequestBody(messages, options);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const url = new URL(this.baseURL + "/chat/completions");
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const requestBody = JSON.stringify(body);

    // We use a simple queue + Promise-based async iterator so chunks are
    // yielded to the caller the instant they arrive from the network.
    const queue = [];
    let resolve = null;
    let done = false;
    let error = null;

    function enqueue(value) {
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
        if (err) r(Promise.reject(err));
        else r({ value: undefined, done: true });
      }
    }

    const req = lib.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Length": Buffer.byteLength(requestBody),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (d) => (body += d.toString()));
          res.on("end", () =>
            finish(new Error(`Mercury API error (${res.statusCode}): ${body}`))
          );
          return;
        }

        let buffer = "";
        res.on("data", (chunk) => {
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

    req.on("error", (err) => finish(err));
    req.write(requestBody);
    req.end();

    // Async iteration: pull from queue or wait for next enqueue
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
        if (result.done) return;
        yield result.value;
      }
    }
  }

  /**
   * Build the request body for Mercury-2.
   */
  _buildRequestBody(messages, options = {}) {
    const body = {
      model: options.model || this.config.model,
      messages,
      max_tokens: options.max_tokens || this.config.max_tokens,
      temperature: options.temperature || this.config.temperature,
      reasoning_effort:
        options.reasoning_effort || this.config.reasoning_effort,
      reasoning_summary:
        options.reasoning_summary ?? this.config.reasoning_summary,
    };

    if (options.stop) body.stop = options.stop;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;
    if (options.tool_choice) body.tool_choice = options.tool_choice;
    if (options.diffusing) {
      body.diffusing = true;
      body.stream = true;
    }

    return body;
  }

  /**
   * Make a non-streaming POST request to the API.
   */
  async _fetch(endpoint, body) {
    const url = this.baseURL + endpoint;
    const requestBody = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const req = lib.request(
        {
          method: "POST",
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk.toString()));
          res.on("end", () => {
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
      req.write(requestBody);
      req.end();
    });
  }
}
