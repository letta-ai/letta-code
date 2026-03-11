/**
 * Semver comparison utilities
 */

/**
 * Parse a semver string into [major, minor, patch]
 * Returns null if invalid format
 */
export function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return [
    parseInt(major ?? "0", 10),
    parseInt(minor ?? "0", 10),
    parseInt(patch ?? "0", 10),
  ];
}

/**
 * Compare two semver versions
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 * Returns null if either version is invalid
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const aParts = parseSemver(a);
  const bParts = parseSemver(b);
  if (!aParts || !bParts) return null;

  for (let i = 0; i < 3; i++) {
    const a = aParts[i] ?? 0;
    const b = bParts[i] ?? 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/**
 * Check if version is less than minimum
 * Returns false if either version is invalid
 */
export function isVersionBelow(version: string, minimum: string): boolean {
  const result = compareSemver(version, minimum);
  return result === -1;
}
