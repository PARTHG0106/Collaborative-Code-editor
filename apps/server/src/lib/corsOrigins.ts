import { config } from '../config/index.js';

/**
 * Characters that survive a copy-paste into a hosting provider's environment
 * variable field while remaining completely invisible in logs. A single one of
 * these inside CORS_ORIGINS is enough to make an exact string comparison fail
 * against a browser's Origin header, which then looks like a server bug
 * because the startup banner prints the value as if it were correct.
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF\u00A0]/g;

/**
 * Reduces an origin to a canonical form for comparison.
 *
 * Browsers send an origin with no trailing slash and a lowercase scheme and
 * host, but humans paste "https://example.com/" constantly, so normalizing both
 * sides removes an entire class of misconfiguration. Note that only the scheme
 * and host are lowercased in practice, because an origin has no path.
 */
export function normalizeOrigin(value: string): string {
  return value
    .replace(INVISIBLE_CHARS, '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Turns an allowlist entry into a matcher.
 *
 * A single "*" is supported so per-deployment preview hostnames can be covered
 * without a redeploy, e.g. "https://my-app-*.vercel.app". The wildcard expands
 * to [a-z0-9-]+, which matches exactly one hostname label and deliberately
 * excludes dots: "https://*.vercel.app" must not match a host that merely ends
 * in ".vercel.app" after further subdomains. This list gates credentialed
 * requests, so a loose pattern here is a real vulnerability.
 */
function toOriginPattern(entry: string): RegExp {
  const escaped = entry
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[a-z0-9-]+');
  return new RegExp(`^${escaped}$`);
}

export type OriginAllowlist = {
  /** Normalized entries, in configuration order. */
  entries: string[];
  /** Entries without a wildcard. */
  exact: string[];
  /** Entries containing a wildcard. */
  wildcard: string[];
  /** Human-readable notes about entries that needed cleaning. */
  warnings: string[];
  isAllowed: (origin: string) => boolean;
};

export function buildOriginAllowlist(rawEntries: readonly string[]): OriginAllowlist {
  const warnings: string[] = [];
  const entries: string[] = [];

  for (const raw of rawEntries) {
    const normalized = normalizeOrigin(raw ?? '');
    if (!normalized) continue;

    if (normalized !== raw) {
      warnings.push(
        `entry ${JSON.stringify(raw)} was normalized to ${JSON.stringify(normalized)}`,
      );
    }

    entries.push(normalized);
  }

  const exact = entries.filter((entry) => !entry.includes('*'));
  const wildcard = entries.filter((entry) => entry.includes('*'));

  const exactSet = new Set(exact);
  const patterns = wildcard.map(toOriginPattern);

  return {
    entries,
    exact,
    wildcard,
    warnings,
    isAllowed: (origin: string) => {
      const normalized = normalizeOrigin(origin ?? '');
      if (!normalized) return false;
      return exactSet.has(normalized) || patterns.some((pattern) => pattern.test(normalized));
    },
  };
}

/** The allowlist in force for this process. */
export const originAllowlist = buildOriginAllowlist(config.corsOrigins);
