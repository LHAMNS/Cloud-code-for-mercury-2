import dns from "node:dns";
import net from "node:net";
import { debugLog } from "./debug-log.js";

/**
 * Normalize an IP address to a canonical form for comparison.
 * Handles IPv4-compatible IPv6, zone IDs, and full-form IPv6.
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  // Strip zone ID (e.g., %eth0)
  ip = ip.replace(/%.*$/, '');
  // IPv4-compatible IPv6 without ffff (e.g., ::127.0.0.1)
  const v4CompatMatch = ip.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4CompatMatch) return v4CompatMatch[1];
  // Full-form IPv6 loopback detection (0000:0000:...:0001)
  if (ip.includes(':') && !ip.includes('.')) {
    const expanded = expandIPv6(ip);
    if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return '::1';
    if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return '::';
    // Check for ffff-mapped in expanded form
    if (expanded.startsWith('0000:0000:0000:0000:0000:ffff:')) {
      const hex = expanded.slice(30); // last 2 groups
      const parts = hex.split(':');
      if (parts.length === 2) {
        const a = parseInt(parts[0].slice(0, 2), 16);
        const b = parseInt(parts[0].slice(2), 16);
        const c = parseInt(parts[1].slice(0, 2), 16);
        const d = parseInt(parts[1].slice(2), 16);
        if ([a,b,c,d].every(n => n >= 0 && n <= 255)) return `${a}.${b}.${c}.${d}`;
      }
    }
  }
  return ip;
}

/**
 * Expand an IPv6 address to full 8-group form.
 * @param {string} ip
 * @returns {string}
 */
export function expandIPv6(ip) {
  try {
    const halves = ip.split('::');
    if (halves.length > 2) return ip; // malformed
    let groups = [];
    if (halves.length === 2) {
      const left = halves[0] ? halves[0].split(':') : [];
      const right = halves[1] ? halves[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    } else {
      groups = ip.split(':');
    }
    return groups.slice(0, 8).map(g => g.padStart(4, '0').toLowerCase()).join(':');
  } catch (err) { debugLog("expandIPv6", err); return ip; }
}

/**
 * Check if an IP address is private, loopback, or link-local.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  // Normalize first (handles IPv4-compat IPv6, zone IDs, full-form)
  ip = normalizeIp(ip);
  // Handle IPv6-mapped IPv4 addresses (e.g., ::ffff:10.0.0.1)
  if (ip.startsWith('::ffff:')) {
    return isPrivateIp(ip.slice(7));
  }
  // Reject non-standard IP representations (octal, hex, decimal)
  if (/^0[0-7]/.test(ip) || /^0x/i.test(ip) || /^\d+$/.test(ip)) {
    return true; // Block non-standard IP formats (could bypass checks)
  }
  // IPv4 loopback
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  // IPv6 loopback
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  // IPv4 private ranges (RFC 1918)
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  // IPv4 link-local
  if (ip.startsWith('169.254.')) return true;
  // IPv4 benchmarking / protocol assignment ranges
  if (/^198\.(1[89])\./.test(ip)) return true;
  if (/^192\.0\.0\./.test(ip)) return true;
  // IPv4 CGNAT
  if (ip.startsWith('100.64.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  // IPv6 private / link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;  // ULA
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;  // link-local
  // Unspecified
  if (ip === '0.0.0.0' || ip.startsWith('0.') || ip === '::') return true;
  // Metadata endpoints (cloud)
  if (ip === '169.254.169.254') return true;
  return false;
}

/**
 * Resolve hostname and check if any resolved address is private/loopback.
 * Also blocks direct IP access to private ranges.
 * @param {string} hostname
 * @returns {Promise<{allowed: boolean, reason?: string, addresses?: string[]}>}
 */
export async function checkSsrf(hostname) {
  // Direct IP literal check
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { allowed: false, reason: `Request to private/loopback address ${hostname} blocked` };
    }
    return { allowed: true, addresses: [hostname] };
  }

  // Block common dangerous hostnames
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower === 'metadata.google.internal') {
    return { allowed: false, reason: `Request to ${hostname} blocked (local/metadata hostname)` };
  }

  // DNS resolution check — resolve hostname and verify all addresses are public
  // Wrapped in timeout to prevent hanging on unresponsive DNS (fail-closed)
  const DNS_TIMEOUT_MS = 5000;
  try {
    const addresses = await Promise.race([
      new Promise((resolve, reject) => {
        dns.resolve(hostname, (err, addrs) => {
          if (err) {
            dns.resolve4(hostname, (err4, a4) => {
              if (err4) {
                dns.resolve6(hostname, (err6, a6) => {
                  if (err6) reject(err6);
                  else resolve(a6);
                });
              } else {
                resolve(a4);
              }
            });
          } else {
            resolve(addrs);
          }
        });
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS resolution timed out')), DNS_TIMEOUT_MS)
      ),
    ]);

    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        return { allowed: false, reason: `${hostname} resolves to private address ${addr}` };
      }
    }
    if (addresses.length === 0) {
      return { allowed: false, reason: `SSRF: DNS resolution returned no addresses for ${hostname}` };
    }
    return { allowed: true, addresses };
  } catch (err) {
    debugLog("checkSsrf.dnsResolve", err);
    return { allowed: false, reason: `SSRF: DNS resolution failed for ${hostname}` };
  }
}
