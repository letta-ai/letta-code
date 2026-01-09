// src/utils/timing.ts
// Debug timing utilities - only active when LETTA_DEBUG_TIMINGS env var is set

/**
 * Check if debug timings are enabled via LETTA_DEBUG_TIMINGS env var
 * Set LETTA_DEBUG_TIMINGS=1 or LETTA_DEBUG_TIMINGS=true to enable timing logs
 */
export function isTimingsEnabled(): boolean {
  const val = process.env.LETTA_DEBUG_TIMINGS;
  return val === "1" || val === "true";
}

/**
 * Format duration nicely: "245ms" or "1.52s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format timestamp: "12:34:56.789"
 */
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

// Simple fetch type that matches the SDK's expected signature
type SimpleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Create an instrumented fetch that logs timing for every request.
 * Logs request start and end (with duration and status) to stderr.
 */
export function createTimingFetch(baseFetch: SimpleFetch): SimpleFetch {
  return async (input, init) => {
    const start = performance.now();
    const startTime = formatTimestamp(new Date());

    // Extract method and URL for logging
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method || "GET";

    // Parse path from URL, handling potential errors
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
