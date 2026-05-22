/**
 * Returns true if value is a non-null, non-array object.
 * Use this instead of `typeof x === "object" && x !== null` when you want
 * to exclude arrays (the most common intent for a "record" check).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
