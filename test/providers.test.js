// Tests for src/providers.js — provider registry, model lookup, registration
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getProvider, getDefaultProvider, listProviders, listProvidersDetailed,
  getProviderForModel, getModelLimits, getProviderApiKey, registerProvider,
} from "../src/providers.js";

describe("getProvider", () => {
  it("returns mercury provider", () => {
    const p = getProvider("mercury");
    assert.ok(p);
    assert.equal(p.name, "mercury");
    assert.ok(p.baseURL.includes("inceptionlabs"));
  });

  it("returns openai provider", () => {
    const p = getProvider("openai");
    assert.ok(p);
    assert.equal(p.name, "openai");
    assert.ok(p.baseURL.includes("openai"));
  });

  it("returns null for unknown provider", () => {
    assert.equal(getProvider("nonexistent"), null);
    assert.equal(getProvider(""), null);
  });
});

describe("getDefaultProvider", () => {
  it("returns mercury as default", () => {
    const p = getDefaultProvider();
    assert.equal(p.name, "mercury");
  });
});

describe("listProviders", () => {
  it("returns array with mercury and openai", () => {
    const names = listProviders();
    assert.ok(Array.isArray(names));
    assert.ok(names.includes("mercury"));
    assert.ok(names.includes("openai"));
  });
});

describe("listProvidersDetailed", () => {
  it("returns detailed provider info with models", () => {
    const detailed = listProvidersDetailed();
    assert.ok(Array.isArray(detailed));
    assert.ok(detailed.length >= 2);

    const mercury = detailed.find(p => p.name === "mercury");
    assert.ok(mercury);
    assert.ok(mercury.displayName);
    assert.ok(mercury.defaultModel);
    assert.ok(Array.isArray(mercury.models));
    assert.ok(mercury.models.length > 0);

    const model = mercury.models[0];
    assert.ok(model.id);
    assert.ok(typeof model.maxContext === "number");
    assert.ok(typeof model.maxOutput === "number");
  });
});

describe("getProviderForModel", () => {
  it("finds mercury provider for mercury-2", () => {
    const p = getProviderForModel("mercury-2");
    assert.ok(p);
    assert.equal(p.name, "mercury");
  });

  it("finds openai provider for gpt-4o", () => {
    const p = getProviderForModel("gpt-4o");
    assert.ok(p);
    assert.equal(p.name, "openai");
  });

  it("finds openai provider for o3", () => {
    const p = getProviderForModel("o3");
    assert.ok(p);
    assert.equal(p.name, "openai");
  });

  it("returns null for unknown model", () => {
    assert.equal(getProviderForModel("nonexistent-model"), null);
  });
});

describe("getModelLimits", () => {
  it("returns correct limits for mercury-2", () => {
    const limits = getModelLimits("mercury", "mercury-2");
    assert.equal(limits.maxContext, 128000);
    assert.equal(limits.maxOutput, 50000);
    assert.deepEqual(limits.tempRange, [0.5, 1.0]);
  });

  it("returns correct limits for gpt-4o", () => {
    const limits = getModelLimits("openai", "gpt-4o");
    assert.equal(limits.maxContext, 128000);
    assert.equal(limits.maxOutput, 16384);
  });

  it("returns fallback limits for unknown model in known provider", () => {
    const limits = getModelLimits("openai", "unknown-model");
    assert.equal(limits.maxContext, 128000);
    assert.equal(limits.maxOutput, 16384);
  });

  it("returns fallback limits for unknown provider", () => {
    const limits = getModelLimits("nonexistent", "any-model");
    assert.equal(limits.maxContext, 128000);
    assert.equal(limits.maxOutput, 16384);
  });
});

describe("getProviderApiKey", () => {
  it("returns null for unknown provider", () => {
    assert.equal(getProviderApiKey("nonexistent"), null);
  });

  it("reads from correct env var for mercury", () => {
    const original = process.env.INCEPTION_API_KEY;
    process.env.INCEPTION_API_KEY = "test-key-123";
    try {
      assert.equal(getProviderApiKey("mercury"), "test-key-123");
    } finally {
      if (original !== undefined) process.env.INCEPTION_API_KEY = original;
      else delete process.env.INCEPTION_API_KEY;
    }
  });

  it("returns null when env var is not set", () => {
    const original = process.env.INCEPTION_API_KEY;
    delete process.env.INCEPTION_API_KEY;
    try {
      assert.equal(getProviderApiKey("mercury"), null);
    } finally {
      if (original !== undefined) process.env.INCEPTION_API_KEY = original;
    }
  });
});

describe("registerProvider", () => {
  it("registers a new provider", () => {
    registerProvider({
      name: "test-provider",
      baseURL: "https://test.example.com/v1",
      displayName: "Test Provider",
    });
    const p = getProvider("test-provider");
    assert.ok(p);
    assert.equal(p.name, "test-provider");
    assert.equal(p.baseURL, "https://test.example.com/v1");
    assert.equal(p.displayName, "Test Provider");
  });

  it("throws when missing name", () => {
    assert.throws(() => registerProvider({ baseURL: "https://test.com" }), /name/);
  });

  it("throws when missing baseURL", () => {
    assert.throws(() => registerProvider({ name: "bad" }), /baseURL/);
  });

  it("sets default envKey from name", () => {
    registerProvider({
      name: "myservice",
      baseURL: "https://myservice.com/v1",
    });
    const p = getProvider("myservice");
    assert.equal(p.envKey, "MYSERVICE_API_KEY");
  });

  it("does not include undefined values in the registered provider", () => {
    registerProvider({
      name: "clean-provider",
      baseURL: "https://clean.example.com",
      models: undefined,
    });
    const p = getProvider("clean-provider");
    assert.ok(p);
    assert.deepEqual(p.models, {});
  });
});
