import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_MAX_TIMEOUT_MS = HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

export function getMonitorMaxTimeoutMs(): number {
  const seconds = process.env.LETTA_MONITOR_MAX_TIMEOUT_SECONDS;
  const value = seconds || process.env.LETTA_MONITOR_MAX_TIMEOUT_MS;
  if (!value || !/^\d+$/.test(value)) return DEFAULT_MAX_TIMEOUT_MS;
  const parsed = seconds ? Number(value) * 1000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TIMEOUT_MS;
  }
  return Math.min(SEVEN_DAYS_MS, Math.max(DEFAULT_MAX_TIMEOUT_MS, parsed));
}

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

export function applyMonitorMaxTimeout(
  text: string,
  timeoutMs: number = getMonitorMaxTimeoutMs(),
): string {
  return text.replaceAll(
    "{{MONITOR_MAX_TIMEOUT}}",
    formatMonitorMaxTimeout(timeoutMs),
  );
}

export function getMonitorTimeoutEvent(
  timeoutMs: number,
  tool = "Monitor",
): string {
  return isManagedCloudRuntime() && timeoutMs === getMonitorMaxTimeoutMs()
    ? `${tool} stopped at the ${timeoutMs / 3_600_000}-hour Cloud sandbox limit. If you still need to watch, re-arm it by calling ${tool} again.`
    : "[Monitor timed out — re-arm if needed.]";
}
