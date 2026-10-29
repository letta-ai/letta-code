const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-sandbox cap, with a one-hour default and a seven-day ceiling. */
export function getMonitorMaxTimeoutMs(): number {
  const value = process.env.LETTA_MONITOR_MAX_TIMEOUT_MS;
  if (!value || !/^\d+$/.test(value)) return DEFAULT_MAX_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_TIMEOUT_MS;
  return Math.min(SEVEN_DAYS_MS, Math.max(DEFAULT_MAX_TIMEOUT_MS, parsed));
}
