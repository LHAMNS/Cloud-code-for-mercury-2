// Tests for src/utils/ssrf.js — SSRF protection, IP normalization, IPv6 expansion
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeIp, expandIPv6, isPrivateIp, checkSsrf } from "../src/utils/ssrf.js";

describe("normalizeIp", () => {
  it("returns empty string for null/undefined/non-string", () => {
    assert.equal(normalizeIp(null), "");
    assert.equal(normalizeIp(undefined), "");
    assert.equal(normalizeIp(123), "");
  });

  it("strips zone IDs", () => {
    assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
    assert.equal(normalizeIp("::1%lo"), "::1");
  });

  it("normalizes IPv4-compatible IPv6 (::x.x.x.x)", () => {
    assert.equal(normalizeIp("::127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeIp("::10.0.0.1"), "10.0.0.1");
  });

  it("normalizes full-form IPv6 loopback to ::1", () => {
    assert.equal(normalizeIp("0000:0000:0000:0000:0000:0000:0000:0001"), "::1");
  });

  it("normalizes full-form IPv6 unspecified to ::", () => {
    assert.equal(normalizeIp("0000:0000:0000:0000:0000:0000:0000:0000"), "::");
  });

  it("normalizes ::ffff-mapped IPv6 to IPv4", () => {
    assert.equal(normalizeIp("0000:0000:0000:0000:0000:ffff:7f00:0001"), "127.0.0.1");
    assert.equal(normalizeIp("0000:0000:0000:0000:0000:ffff:0a00:0001"), "10.0.0.1");
  });

  it("passes through plain IPv4 unchanged", () => {
    assert.equal(normalizeIp("8.8.8.8"), "8.8.8.8");
    assert.equal(normalizeIp("192.168.1.1"), "192.168.1.1");
  });
});

describe("expandIPv6", () => {
  it("expands :: to full form", () => {
    assert.equal(expandIPv6("::1"), "0000:0000:0000:0000:0000:0000:0000:0001");
    assert.equal(expandIPv6("::"), "0000:0000:0000:0000:0000:0000:0000:0000");
  });

  it("expands partial :: addresses", () => {
    assert.equal(expandIPv6("fe80::1"), "fe80:0000:0000:0000:0000:0000:0000:0001");
    assert.equal(expandIPv6("2001:db8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
  });

  it("handles full addresses without ::", () => {
    assert.equal(
      expandIPv6("2001:0db8:0000:0000:0000:0000:0000:0001"),
      "2001:0db8:0000:0000:0000:0000:0000:0001"
    );
  });

  it("returns malformed addresses with multiple :: unchanged", () => {
    const bad = "::1::2";
    assert.equal(expandIPv6(bad), bad);
  });
});

describe("isPrivateIp", () => {
  const PRIVATE_IPS = [
    "127.0.0.1", "127.0.0.2", "127.255.255.255",
    "10.0.0.1", "10.255.255.255",
    "192.168.0.1", "192.168.255.255",
    "172.16.0.1", "172.31.255.255",
    "169.254.0.1", "169.254.169.254",
    "0.0.0.0", "0.1.2.3",
    "::1", "::",
    "fc00::1", "fd12::1",
    "fe80::1",
    "100.64.0.1", "100.127.255.255",
    "198.18.0.1", "198.19.255.255",
    "192.0.0.1",
  ];

  for (const ip of PRIVATE_IPS) {
    it(`detects ${ip} as private`, () => {
      assert.ok(isPrivateIp(ip), `${ip} should be private`);
    });
  }

  const PUBLIC_IPS = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34",
    "203.0.113.1", "198.51.100.1",
  ];

  for (const ip of PUBLIC_IPS) {
    it(`detects ${ip} as public`, () => {
      assert.ok(!isPrivateIp(ip), `${ip} should be public`);
    });
  }

  it("blocks octal IP representations", () => {
    assert.ok(isPrivateIp("0177.0.0.1"));
  });

  it("blocks hex IP representations", () => {
    assert.ok(isPrivateIp("0x7f000001"));
  });

  it("blocks decimal IP representations", () => {
    assert.ok(isPrivateIp("2130706433"));
  });

  it("detects ::ffff-mapped private IPs", () => {
    assert.ok(isPrivateIp("::ffff:127.0.0.1"));
    assert.ok(isPrivateIp("::ffff:10.0.0.1"));
  });

  it("handles IPv4-compatible IPv6 private IPs", () => {
    assert.ok(isPrivateIp("::127.0.0.1"));
    assert.ok(isPrivateIp("::10.0.0.1"));
  });
});

describe("checkSsrf", () => {
  it("blocks direct private IP literals", async () => {
    const result = await checkSsrf("127.0.0.1");
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("private"));
  });

  it("blocks localhost hostname", async () => {
    const result = await checkSsrf("localhost");
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("blocked"));
  });

  it("blocks .local hostnames", async () => {
    const result = await checkSsrf("myhost.local");
    assert.equal(result.allowed, false);
  });

  it("blocks metadata.google.internal", async () => {
    const result = await checkSsrf("metadata.google.internal");
    assert.equal(result.allowed, false);
  });

  it("allows public IP literals", async () => {
    const result = await checkSsrf("8.8.8.8");
    assert.equal(result.allowed, true);
    assert.deepEqual(result.addresses, ["8.8.8.8"]);
  });

  it("blocks ::1 IPv6 loopback", async () => {
    const result = await checkSsrf("::1");
    assert.equal(result.allowed, false);
  });

  it("blocks 10.x.x.x private range", async () => {
    const result = await checkSsrf("10.0.0.1");
    assert.equal(result.allowed, false);
  });

  it("blocks cloud metadata endpoint IP", async () => {
    const result = await checkSsrf("169.254.169.254");
    assert.equal(result.allowed, false);
  });
});
