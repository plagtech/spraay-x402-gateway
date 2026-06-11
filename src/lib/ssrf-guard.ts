// src/lib/ssrf-guard.ts
import { lookup } from "dns/promises";
import { URL } from "url";

const BLOCKED_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^::1$/, /^fc00:/i, /^fe80:/i,
];

const BLOCKED_HOSTNAMES = [
  "localhost", "metadata.google.internal", "metadata.google",
  "169.254.169.254", "100.100.100.200", "fd00::",
];

export async function validateOutboundURL(urlString: string): Promise<{ safe: boolean; error?: string; hostname?: string }> {
  let parsed: URL;
  try { parsed = new URL(urlString); } catch { return { safe: false, error: "Invalid URL" }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { safe: false, error: `Protocol "${parsed.protocol}" not allowed` };
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname)) return { safe: false, error: "Blocked hostname" };
  try {
    const { address } = await lookup(hostname);
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(address)) return { safe: false, error: "Resolved to a private/reserved IP range" };
    }
  } catch (err: any) {
    return { safe: false, error: `DNS resolution failed: ${err.code || err.message}` };
  }
  return { safe: true, hostname };
}
