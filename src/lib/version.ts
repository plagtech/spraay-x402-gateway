// ============================================
// GATEWAY VERSION — single source of truth
// src/lib/version.ts
// ============================================
//
// The gateway version is advertised in discovery documents, 402 bodies and
// the x-spraay-meta header from several unrelated modules. Those used to be
// hand-written string literals, which drifted (three modules still reported
// 3.7.0 long after the gateway shipped 3.8.1).
//
// Reading it from package.json at boot means the version can only ever be
// changed in one place. package.json is not `import`ed because it lives
// outside tsconfig's rootDir (./src); it is read from disk instead.
//
// This never throws: if package.json cannot be read for any reason, the
// pinned FALLBACK_VERSION is used so a bad deploy can't take the gateway down
// over a version string.
// ============================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Kept in step with package.json — only used if package.json is unreadable.
const FALLBACK_VERSION = "3.8.2";

function readPackageVersion(): string {
  // src/lib/version.ts and dist/lib/version.js sit at the same depth, so
  // "../.." resolves to the repo root from either the TS or compiled path.
  const candidates = [
    join(__dirname, "..", "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
      if (typeof parsed?.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Unreadable or malformed — try the next candidate.
    }
  }

  return FALLBACK_VERSION;
}

export const GATEWAY_VERSION: string = readPackageVersion();
