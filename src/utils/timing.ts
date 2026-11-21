
export function isTimingsEnabled(): boolean {
  const val = process.env.LETTA_DEBUG_TIMINGS;
  return val === "1" || val === "true";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 23);
}

/**
 * Log timing message to stderr (won't interfere with stdout JSON in headless mode)
 */
export function logTiming(message: string): void {
  if (isTimingsEnabled()) {
    console.error(`[timing] ${message}`);
  }
}

const milestones: Map<string, number> = new Map();

let firstMilestoneTime: number | null = null;

export function markMilestone(name: string): void {
  const now = performance.now();
  milestones.set(name, now);

  if (firstMilestoneTime === null) {
    firstMilestoneTime = now;
  }

  if (isTimingsEnabled()) {
    const relative = now - firstMilestoneTime;
    console.error(
      `[timing] MILESTONE ${name} at +${formatDuration(relative)} (${formatTimestamp(new Date())})`,
    );
  }
}

export function measureSinceMilestone(
  label: string,
  fromMilestone: string,
): void {
  if (!isTimingsEnabled()) return;

  const startTime = milestones.get(fromMilestone);
  if (startTime === undefined) {
    console.error(
      `[timing] WARNING: milestone "${fromMilestone}" not found for measurement "${label}"`,
    );
    return;
  }

  const duration = performance.now() - startTime;
  console.error(`[timing] ${label}: ${formatDuration(duration)}`);
}

export function getMilestoneDuration(
  fromMilestone: string,
  toMilestone: string,
): number | null {
  const start = milestones.get(fromMilestone);
  const end = milestones.get(toMilestone);
  if (start === undefined || end === undefined) return null;
  return end - start;
}

export function reportAllMilestones(): void {
  if (!isTimingsEnabled() || milestones.size === 0) return;

  const first = firstMilestoneTime ?? 0;

  console.error(`[timing] ======== MILESTONE SUMMARY ========`);

  const sorted = [...milestones.entries()].sort((a, b) => a[1] - b[1]);

  let prevTime = first;
  for (const [name, time] of sorted) {
    const relativeToStart = time - first;
    const delta = time - prevTime;
    const deltaStr = prevTime === first ? "" : ` (+${formatDuration(delta)})`;
    console.error(
      `[timing]   +${formatDuration(relativeToStart).padStart(8)} ${name}${deltaStr}`,
    );
    prevTime = time;
  }

  console.error(`[timing] =====================================`);
}

export function clearMilestones(): void {
  milestones.clear();
  firstMilestoneTime = null;
}

// Simple fetch type that matches the SDK's expected signature
type SimpleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createTimingFetch(baseFetch: SimpleFetch): SimpleFetch {
  return async (input, init) => {
    const start = performance.now();
    const startTime = formatTimestamp(new Date());

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method || "GET";

    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }

    logTiming(`${method} ${path} started at ${startTime}`);

    try {
      const response = await baseFetch(input, init);
      const duration = performance.now() - start;
      logTiming(
        `${method} ${path} -> ${formatDuration(duration)} (status: ${response.status})`,
      );
      return response;
    } catch (error) {
      const duration = performance.now() - start;
      logTiming(
        `${method} ${path} -> FAILED after ${formatDuration(duration)}`,
      );
      throw error;
    }
  };
}
