// Mercury Code - SSRF Protection
// URL parsing, IP address validation, block internal/private IPs.
// Ported from: src/utils/ssrf.js

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum SsrfError {
    #[error("Request to private/loopback address {0} blocked")]
    PrivateIp(String),

    #[error("Request to {0} blocked (local/metadata hostname)")]
    LocalHostname(String),

    #[error("DNS resolution failed for {0}: {1}")]
    DnsFailure(String, String),

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
}

/// Result of an SSRF check.
#[derive(Debug, Clone)]
pub struct SsrfCheckResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub addresses: Vec<String>,
}

impl SsrfCheckResult {
    fn allowed(addresses: Vec<String>) -> Self {
        Self {
            allowed: true,
            reason: None,
            addresses,
        }
    }

    fn blocked(reason: String) -> Self {
        Self {
            allowed: false,
            reason: Some(reason),
            addresses: Vec::new(),
        }
    }
}

/// Normalize an IP address to a canonical form for comparison.
/// Handles IPv4-compatible IPv6, zone IDs, and full-form IPv6.
pub fn normalize_ip(ip: &str) -> String {
    if ip.is_empty() {
        return String::new();
    }

    // Strip zone ID (e.g., %eth0)
    let ip = if let Some(idx) = ip.find('%') {
        &ip[..idx]
    } else {
        ip
    };

    // IPv4-compatible IPv6 without ffff (e.g., ::127.0.0.1)
    if ip.starts_with("::") && !ip.starts_with("::ffff:") {
        let rest = &ip[2..];
        if rest.contains('.') && is_ipv4_like(rest) {
            return rest.to_string();
        }
    }

    // Pure IPv6 (no dots)
    if ip.contains(':') && !ip.contains('.') {
        let expanded = expand_ipv6(ip);
        if expanded == "0000:0000:0000:0000:0000:0000:0000:0001" {
            return "::1".to_string();
        }
        if expanded == "0000:0000:0000:0000:0000:0000:0000:0000" {
            return "::".to_string();
        }
        // Check for ffff-mapped in expanded form
        if expanded.starts_with("0000:0000:0000:0000:0000:ffff:") {
            let hex_part = &expanded[30..];
            let parts: Vec<&str> = hex_part.split(':').collect();
            if parts.len() == 2 {
                if let (Ok(ab), Ok(cd)) = (
                    u16::from_str_radix(parts[0], 16),
                    u16::from_str_radix(parts[1], 16),
                ) {
                    let a = (ab >> 8) as u8;
                    let b = (ab & 0xff) as u8;
                    let c = (cd >> 8) as u8;
                    let d = (cd & 0xff) as u8;
                    return format!("{}.{}.{}.{}", a, b, c, d);
                }
            }
        }
    }

    ip.to_string()
}

fn is_ipv4_like(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| p.parse::<u8>().is_ok())
}

/// Expand an IPv6 address to full 8-group form.
pub fn expand_ipv6(ip: &str) -> String {
    let halves: Vec<&str> = ip.split("::").collect();
    if halves.len() > 2 {
        return ip.to_string(); // malformed
    }

    let groups: Vec<String> = if halves.len() == 2 {
        let left: Vec<&str> = if halves[0].is_empty() {
            Vec::new()
        } else {
            halves[0].split(':').collect()
        };
        let right: Vec<&str> = if halves[1].is_empty() {
            Vec::new()
        } else {
            halves[1].split(':').collect()
        };
        let missing = 8usize.saturating_sub(left.len() + right.len());
        let mut result: Vec<String> = left.iter().map(|s| s.to_string()).collect();
        result.extend(std::iter::repeat("0".to_string()).take(missing));
        result.extend(right.iter().map(|s| s.to_string()));
        result
    } else {
        ip.split(':').map(|s| s.to_string()).collect()
    };

    groups
        .iter()
        .take(8)
        .map(|g| format!("{:0>4}", g.to_lowercase()))
        .collect::<Vec<_>>()
        .join(":")
}

/// Check if an IP address is private, loopback, or link-local.
pub fn is_private_ip(ip: &str) -> bool {
    let ip = normalize_ip(ip);
    let ip = ip.as_str();

    // Handle IPv6-mapped IPv4 addresses (e.g., ::ffff:10.0.0.1)
    if let Some(v4) = ip.strip_prefix("::ffff:") {
        return is_private_ip(v4);
    }

    // Reject non-standard IP representations (octal, hex, decimal)
    if (ip.starts_with("0") && ip.len() > 1 && ip.chars().nth(1).map_or(false, |c| c.is_ascii_digit()))
        || ip.starts_with("0x")
        || ip.starts_with("0X")
        || (ip.chars().all(|c| c.is_ascii_digit()) && ip.contains('.') == false && ip.len() > 2)
    {
        return true; // Block non-standard IP formats
    }

    // IPv4 loopback
    if ip == "127.0.0.1" || ip.starts_with("127.") {
        return true;
    }

    // IPv6 loopback
    if ip == "::1" || ip == "::ffff:127.0.0.1" {
        return true;
    }

    // IPv4 private ranges (RFC 1918)
    if ip.starts_with("10.") {
        return true;
    }
    if ip.starts_with("192.168.") {
        return true;
    }

    // 172.16.0.0 - 172.31.255.255
    if ip.starts_with("172.") {
        if let Some(second_octet) = ip.split('.').nth(1).and_then(|s| s.parse::<u8>().ok()) {
            if (16..=31).contains(&second_octet) {
                return true;
            }
        }
    }

    // IPv4 link-local
    if ip.starts_with("169.254.") {
        return true;
    }

    // IPv4 benchmarking
    if ip.starts_with("198.18.") || ip.starts_with("198.19.") {
        return true;
    }
    if ip.starts_with("192.0.0.") {
        return true;
    }

    // IPv4 CGNAT (100.64.0.0/10)
    if ip.starts_with("100.") {
        if let Some(second_octet) = ip.split('.').nth(1).and_then(|s| s.parse::<u8>().ok()) {
            if (64..=127).contains(&second_octet) {
                return true;
            }
        }
    }

    // IPv6 private / link-local
    if ip.starts_with("fc") || ip.starts_with("fd") {
        return true; // ULA
    }
    {
        let lower = ip.to_lowercase();
        if lower.len() >= 5 && lower.starts_with("fe") {
            if let Some(third_char) = lower.chars().nth(2) {
                if matches!(third_char, '8' | '9' | 'a' | 'b') {
                    return true; // link-local
                }
            }
        }
    }

    // Unspecified
    if ip == "0.0.0.0" || ip.starts_with("0.") || ip == "::" {
        return true;
    }

    // Metadata endpoints (cloud)
    if ip == "169.254.169.254" {
        return true;
    }

    false
}

/// Check an IP address string, returning whether it's safe.
pub fn check_ip(ip: &str) -> SsrfCheckResult {
    if is_private_ip(ip) {
        SsrfCheckResult::blocked(format!(
            "Request to private/loopback address {} blocked",
            ip
        ))
    } else {
        SsrfCheckResult::allowed(vec![ip.to_string()])
    }
}

/// Check a hostname for SSRF vulnerabilities (synchronous, no DNS resolution).
/// For full DNS-based checking, use `check_ssrf_async`.
pub fn check_ssrf_hostname(hostname: &str) -> SsrfCheckResult {
    // Direct IP literal check
    if hostname.parse::<IpAddr>().is_ok() {
        return check_ip(hostname);
    }

    // Block common dangerous hostnames
    let lower = hostname.to_lowercase();
    if lower == "localhost"
        || lower.ends_with(".local")
        || lower == "metadata.google.internal"
    {
        return SsrfCheckResult::blocked(format!(
            "Request to {} blocked (local/metadata hostname)",
            hostname
        ));
    }

    // Without DNS resolution, we allow but note it needs async verification
    SsrfCheckResult::allowed(Vec::new())
}

/// Parse a URL and extract the hostname for SSRF checking.
/// Also validates the URL structure.
pub fn check_url_ssrf(url_str: &str) -> Result<SsrfCheckResult, SsrfError> {
    let url = Url::parse(url_str).map_err(|e| SsrfError::InvalidUrl(e.to_string()))?;

    // Only allow http and https
    if url.scheme() != "http" && url.scheme() != "https" {
        return Ok(SsrfCheckResult::blocked(format!(
            "Protocol {} is not allowed",
            url.scheme()
        )));
    }

    // Block URLs with embedded credentials
    if !url.username().is_empty() || url.password().is_some() {
        return Ok(SsrfCheckResult::blocked(
            "URLs with embedded credentials are blocked".to_string(),
        ));
    }

    let hostname = url
        .host_str()
        .ok_or_else(|| SsrfError::InvalidUrl("No hostname in URL".to_string()))?;

    Ok(check_ssrf_hostname(hostname))
}

/// Async SSRF check with DNS resolution.
/// Resolves hostname and checks if any resolved address is private/loopback.
#[cfg(feature = "async-dns")]
pub async fn check_ssrf_async(hostname: &str) -> SsrfCheckResult {
    use tokio::net::lookup_host;
    use tokio::time::{timeout, Duration};

    // Direct IP literal check
    if hostname.parse::<IpAddr>().is_ok() {
        return check_ip(hostname);
    }

    // Block common dangerous hostnames
    let lower = hostname.to_lowercase();
    if lower == "localhost" || lower.ends_with(".local") || lower == "metadata.google.internal" {
        return SsrfCheckResult::blocked(format!(
            "Request to {} blocked (local/metadata hostname)",
            hostname
        ));
    }

    // DNS resolution with timeout
    let dns_timeout = Duration::from_secs(5);
    let lookup_result = timeout(dns_timeout, lookup_host(format!("{}:0", hostname))).await;

    match lookup_result {
        Ok(Ok(addrs)) => {
            let addresses: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            if addresses.is_empty() {
                return SsrfCheckResult::blocked(format!(
                    "SSRF: DNS resolution returned no addresses for {}",
                    hostname
                ));
            }
            for addr in &addresses {
                if is_private_ip(addr) {
                    return SsrfCheckResult::blocked(format!(
                        "{} resolves to private address {}",
                        hostname, addr
                    ));
                }
            }
            SsrfCheckResult::allowed(addresses)
        }
        Ok(Err(e)) => SsrfCheckResult::blocked(format!(
            "SSRF: DNS resolution failed for {}: {}",
            hostname, e
        )),
        Err(_) => SsrfCheckResult::blocked(format!(
            "SSRF: DNS resolution timed out for {}",
            hostname
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_private_ip_v4() {
        assert!(is_private_ip("127.0.0.1"));
        assert!(is_private_ip("127.0.0.2"));
        assert!(is_private_ip("10.0.0.1"));
        assert!(is_private_ip("10.255.255.255"));
        assert!(is_private_ip("192.168.1.1"));
        assert!(is_private_ip("172.16.0.1"));
        assert!(is_private_ip("172.31.255.255"));
        assert!(is_private_ip("169.254.1.1"));
        assert!(is_private_ip("169.254.169.254")); // cloud metadata
        assert!(is_private_ip("0.0.0.0"));

        // Not private
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("1.1.1.1"));
        assert!(!is_private_ip("172.32.0.1"));
        assert!(!is_private_ip("192.169.1.1"));
    }

    #[test]
    fn test_is_private_ip_v6() {
        assert!(is_private_ip("::1"));
        assert!(is_private_ip("::"));
        assert!(is_private_ip("fc00::1"));
        assert!(is_private_ip("fd00::1"));
        assert!(is_private_ip("fe80::1"));
    }

    #[test]
    fn test_normalize_ip() {
        assert_eq!(normalize_ip("::127.0.0.1"), "127.0.0.1");
        assert_eq!(normalize_ip("::1"), "::1");
        assert_eq!(
            normalize_ip("0000:0000:0000:0000:0000:0000:0000:0001"),
            "::1"
        );
    }

    #[test]
    fn test_expand_ipv6() {
        assert_eq!(
            expand_ipv6("::1"),
            "0000:0000:0000:0000:0000:0000:0000:0001"
        );
        assert_eq!(
            expand_ipv6("fe80::1"),
            "fe80:0000:0000:0000:0000:0000:0000:0001"
        );
    }

    #[test]
    fn test_check_ssrf_hostname() {
        assert!(!check_ssrf_hostname("localhost").allowed);
        assert!(!check_ssrf_hostname("foo.local").allowed);
        assert!(!check_ssrf_hostname("metadata.google.internal").allowed);
        assert!(!check_ssrf_hostname("127.0.0.1").allowed);
        assert!(!check_ssrf_hostname("10.0.0.1").allowed);
        assert!(check_ssrf_hostname("example.com").allowed);
    }

    #[test]
    fn test_check_url_ssrf() {
        // Blocked protocols
        let result = check_url_ssrf("ftp://example.com/file").unwrap();
        assert!(!result.allowed);

        // Embedded credentials
        let result = check_url_ssrf("https://user:pass@example.com/").unwrap();
        assert!(!result.allowed);

        // Private IP
        let result = check_url_ssrf("https://127.0.0.1/api").unwrap();
        assert!(!result.allowed);

        // Valid
        let result = check_url_ssrf("https://example.com/api").unwrap();
        assert!(result.allowed);
    }

    #[test]
    fn test_non_standard_ip_blocked() {
        // Octal-like
        assert!(is_private_ip("0177.0.0.1"));
        // Hex-like
        assert!(is_private_ip("0x7f000001"));
    }
}
