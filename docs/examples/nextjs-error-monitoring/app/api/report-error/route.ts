/**
 * POST /api/report-error
 *
 * Receives error reports from the client (browser error boundaries,
 * unhandled promise rejections, etc.) and runs them through the full
 * server-side reporting pipeline (email + GitHub issue).
 *
 * Authentication: The client must include a shared secret in the
 * X-Error-Report-Secret header to prevent abuse.
 *
 * Body (JSON):
 *   { title, message, stack?, url?, componentStack?, severity?, context? }
 *
 * Returns:
 *   201 { ok: true }
 *   401 if the secret is missing / wrong
 *   422 if the body is malformed
 *   500 if the pipeline itself crashes
 */

import { type NextRequest, NextResponse } from "next/server";
import { reportError, type ErrorReport } from "@/lib/error-reporter";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ──────────────────────────────────────────────────────
  const secret = process.env.ERROR_REPORT_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-error-report-secret");
    if (incoming !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // ── 2. Parse body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 422 });
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.title !== "string" || typeof raw.message !== "string") {
    return NextResponse.json(
      { error: "title and message are required strings" },
      { status: 422 }
    );
  }

  const report: ErrorReport = {
    title: raw.title.slice(0, 200),
    message: (raw.message as string).slice(0, 2000),
    stack: typeof raw.stack === "string" ? raw.stack.slice(0, 5000) : undefined,
    url: typeof raw.url === "string" ? raw.url.slice(0, 500) : undefined,
    method: typeof raw.method === "string" ? raw.method : undefined,
    componentStack:
      typeof raw.componentStack === "string"
        ? raw.componentStack.slice(0, 5000)
        : undefined,
    severity: (["low", "medium", "high", "critical"] as const).includes(
      raw.severity as "low" | "medium" | "high" | "critical"
    )
      ? (raw.severity as ErrorReport["severity"])
      : "high",
    context:
      typeof raw.context === "object" && raw.context !== null
        ? (raw.context as Record<string, unknown>)
        : undefined,
  };

  // ── 3. Run pipeline ───────────────────────────────────────────────────────
  try {
    await reportError(report);
  } catch (err) {
    console.error("[report-error] Unexpected pipeline failure:", err);
    return NextResponse.json({ error: "Pipeline error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
