// src/lib/ssrf-guard.ts
import { lookup } from "dns/promises";
import { URL } from "url";

const BLOCKED_IPV4_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
];

const BLOCKED_IPV6_RANGES = [
  /^::$/, /^(?:0{1,4}:){7}0{1,4}$/i,   // :: unspecified
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,   // fc00::/7 unique local (fc00:: – fdff::)
  /^fe[89ab][0-9a-f]:/i,   // fe80::/10 link-local (fe80:: – febf::)
];

const BLOCKED_HOSTNAMES = [
  "localhost", "metadata.google.internal", "metadata.google",
  "169.254.169.254", "100.100.100.200", "fd00::",
];

// IPv6 forms that embed an IPv4 address in the low 32 bits, checked against
// the IPv4 ranges: IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96. Either
// may be dotted (::ffff:10.0.0.1) or hex (::ffff:a00:1); WHATWG URL
// serializes [::ffff:10.0.0.1] to the hex form, so both reach lookup().
const MAPPED_IPV4 = /^(?:::ffff:|(?:0{1,4}:){5}ffff:|0{0,2}64:ff9b::|0{0,2}64:ff9b:(?:0{1,4}:){4})(.*)$/i;

function embeddedIPv4(address: string): string | null {
  const m = MAPPED_IPV4.exec(address);
  if (!m) return null;
  const tail = m[1];
  if (tail.includes(".")) return tail;
  // Hex low 32 bits: "a00:1", or one group when the high half is zero
  // ("::ffff:1" is 0.0.0.1), or nothing at all ("64:ff9b::" is 0.0.0.0).
  const hex = /^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})?$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1] ?? "0", 16), lo = parseInt(hex[2] ?? "0", 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True if a resolved address is loopback, private, link-local or otherwise reserved. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase();
  const v4 = embeddedIPv4(ip) ?? (ip.includes(":") ? null : ip);
  if (v4 !== null) return BLOCKED_IPV4_RANGES.some(p => p.test(v4));
  return BLOCKED_IPV6_RANGES.some(p => p.test(ip));
}

export async function validateOutboundURL(urlString: string): Promise<{ safe: boolean; error?: string; hostname?: string }> {
  let parsed: URL;
  try { parsed = new URL(urlString); } catch { return { safe: false, error: "Invalid URL" }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { safe: false, error: `Protocol "${parsed.protocol}" not allowed` };
  // IPv6 literals arrive bracketed ("[fd12::1]"); strip so lookup() behaves the same on every platform.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (BLOCKED_HOSTNAMES.includes(hostname)) return { safe: false, error: "Blocked hostname" };
  try {
    const { address } = await lookup(hostname);
    if (isBlockedAddress(address)) return { safe: false, error: "Resolved to a private/reserved IP range" };
  } catch (err: any) {
    return { safe: false, error: `DNS resolution failed: ${err.code || err.message}` };
  }
  return { safe: true, hostname };
}
