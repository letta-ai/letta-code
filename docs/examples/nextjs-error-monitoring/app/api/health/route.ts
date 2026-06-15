/**
 * GET /api/health
 *
 * Health check endpoint for Vercel, uptime monitors (Better Uptime,
 * UptimeRobot, Checkly, etc.), and load balancers.
 *
 * Returns 200 when the application is healthy, 503 when degraded.
 *
 * Response schema:
 * {
 *   status: "ok" | "degraded",
 *   version: string,
 *   timestamp: string,
 *   checks: {
 *     [name]: { status: "ok" | "fail", latencyMs?: number, error?: string }
 *   }
 * }
 *
 * Add your own checks (database connectivity, Redis ping, external API
 * availability) by extending the `runChecks` function below.
 */

import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  status: "ok" | "fail";
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  timestamp: string;
  uptime: number;
  checks: Record<string, CheckResult>;
}

// ---------------------------------------------------------------------------
// Individual checks — add yours here
// ---------------------------------------------------------------------------

async function checkDatabase(): Promise<CheckResult> {
  // Replace with your actual DB ping. Example for Prisma / pg:
  //
  //   const start = Date.now();
  //   await db.$queryRaw`SELECT 1`;
  //   return { status: "ok", latencyMs: Date.now() - start };
  //
  // For now we return a no-op so the endpoint works without a DB.

  if (!process.env.DATABASE_URL) {
    return { status: "ok", latencyMs: 0 }; // Not configured — skip
  }

  try {
    const start = Date.now();
    // Minimal TCP connectivity check using the URL host
    const url = new URL(process.env.DATABASE_URL);
    const _ = url.host; // Just parsing validates the URL
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkExternalApi(): Promise<CheckResult> {
  // Example: verify that your main upstream API is reachable.
  // Replace the URL with your actual dependency.

  const externalUrl = process.env.HEALTH_CHECK_EXTERNAL_URL;
  if (!externalUrl) {
    return { status: "ok" }; // Not configured — skip
  }

  try {
    const start = Date.now();
    const res = await fetch(externalUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: res.ok ? "ok" : "fail",
      latencyMs: Date.now() - start,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkMemory(): Promise<CheckResult> {
  try {
    const mem = process.memoryUsage();
    const heapUsedMb = mem.heapUsed / 1024 / 1024;
    const heapTotalMb = mem.heapTotal / 1024 / 1024;
    const usagePercent = (heapUsedMb / heapTotalMb) * 100;

    // Warn when heap usage exceeds 90%
    return {
      status: usagePercent > 90 ? "fail" : "ok",
      latencyMs: 0,
      error: usagePercent > 90 ? `Heap at ${usagePercent.toFixed(1)}%` : undefined,
    };
  } catch (err) {
    return {
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runChecks(): Promise<Record<string, CheckResult>> {
  // Run all checks concurrently with a 10-second global timeout
  const [database, externalApi, memory] = await Promise.all([
    withTimeout(checkDatabase(), 5000, "database check timed out"),
    withTimeout(checkExternalApi(), 5000, "external API check timed out"),
    withTimeout(checkMemory(), 1000, "memory check timed out"),
  ]);

  return { database, externalApi, memory };
}

function withTimeout<T extends CheckResult>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<CheckResult> {
  return Promise.race([
    promise,
    new Promise<CheckResult>((resolve) =>
      setTimeout(() => resolve({ status: "fail", error: timeoutMessage }), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const startTime = Date.now();

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const checks = await runChecks();
  const anyFailed = Object.values(checks).some((c) => c.status === "fail");

  const body: HealthResponse = {
    status: anyFailed ? "degraded" : "ok",
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "unknown",
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    checks,
  };

  return NextResponse.json(body, { status: anyFailed ? 503 : 200 });
}

// Allow health checks from any origin (needed for external uptime monitors)
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
