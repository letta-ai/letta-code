const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_MAX_TIMEOUT_MS = HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/**
 * Per-sandbox cap from LETTA_MONITOR_MAX_TIMEOUT_SECONDS, with a one-hour
 * default and a seven-day ceiling. Returned in milliseconds for timers.
 */
export function getMonitorMaxTimeoutMs(): number {
  const value = process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  if (!value || !/^\d+$/.test(value)) return DEFAULT_MAX_TIMEOUT_MS;
  const parsed = Number(value) * 1000;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TIMEOUT_MS;
  }
  return Math.min(SEVEN_DAYS_MS, Math.max(DEFAULT_MAX_TIMEOUT_MS, parsed));
}

/** Human-readable cap, such as "1 hour", "24 hours", or "7 days". */
export function formatMonitorMaxTimeout(
  timeoutMs: number = getMonitorMaxTimeoutMs(),
): string {
  const days = timeoutMs >= 2 * DAY_MS && timeoutMs % DAY_MS === 0;
  const value = days
    ? timeoutMs / DAY_MS
    : Math.round((timeoutMs / HOUR_MS) * 100) / 100;
  const unit = days ? "day" : "hour";
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/**
 * Renders the configured cap into Monitor and WatchPR descriptions so the
 * model sees this sandbox's limit instead of the one-hour default.
 */
export function applyMonitorMaxTimeout(
  text: string,
  timeoutMs: number = getMonitorMaxTimeoutMs(),
): string {
  return text.replaceAll(
    "{{MONITOR_MAX_TIMEOUT}}",
    formatMonitorMaxTimeout(timeoutMs),
  );
}
