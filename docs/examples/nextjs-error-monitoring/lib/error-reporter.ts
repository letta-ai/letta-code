/**
 * error-reporter.ts
 *
 * Central error reporting pipeline for Next.js / Vercel.
 * Handles:
 *   - Email alerts via Resend (or any SMTP provider)
 *   - Automatic GitHub issue creation with full context
 *   - Deduplication so one flurry of errors doesn't spam 100 issues
 *   - Structured payloads for easy triage
 *
 * Environment variables required (set in Vercel dashboard or .env.local):
 *   RESEND_API_KEY          – Resend API key  (https://resend.com)
 *   ALERT_EMAIL_FROM        – Sender address  e.g. alerts@yourdomain.com
 *   ALERT_EMAIL_TO          – Recipient       e.g. oncall@yourcompany.com
 *   GITHUB_TOKEN            – Fine-grained PAT with Issues: Read & Write
 *   GITHUB_REPO             – owner/repo      e.g. acme/my-app
 *   NEXT_PUBLIC_APP_URL     – Public URL      e.g. https://app.acme.com
 *   ERROR_REPORT_SECRET     – Random string to authenticate client→server POSTs
 */

export interface ErrorReport {
  /** Short human-readable summary */
  title: string;
  /** Full error message */
  message: string;
  /** Stack trace (if available) */
  stack?: string;
  /** Route / page where the error occurred */
  url?: string;
  /** HTTP method (for API route errors) */
  method?: string;
  /** Which component threw (React error boundary) */
  componentStack?: string;
  /** Severity tier */
  severity?: "low" | "medium" | "high" | "critical";
  /** Arbitrary additional context */
  context?: Record<string, unknown>;
  /** ISO timestamp — filled automatically if omitted */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Simple 15-minute in-memory dedup window (resets on cold start). */
const recentIssues = new Map<string, number>();
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

function deduplicationKey(report: ErrorReport): string {
  // Key on first 120 chars of message to group similar errors
  return `${report.title.slice(0, 80)}::${(report.message ?? "").slice(0, 120)}`;
}

function isRecent(key: string): boolean {
  const last = recentIssues.get(key);
  return last !== undefined && Date.now() - last < DEDUP_WINDOW_MS;
}

function markSeen(key: string): void {
  recentIssues.set(key, Date.now());
  // Prune old entries so the map doesn't grow forever
  for (const [k, ts] of recentIssues.entries()) {
    if (Date.now() - ts > DEDUP_WINDOW_MS) recentIssues.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Email alert (Resend)
// ---------------------------------------------------------------------------

async function sendEmailAlert(report: ErrorReport): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM;
  const to = process.env.ALERT_EMAIL_TO;

  if (!apiKey || !from || !to) {
    console.warn("[error-reporter] Email env vars missing — skipping email alert");
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "unknown";
  const severity = report.severity ?? "high";
  const severityEmoji: Record<string, string> = {
    low: "🟡",
    medium: "🟠",
    high: "🔴",
    critical: "🚨",
  };

  const subject = `${severityEmoji[severity] ?? "🔴"} [${severity.toUpperCase()}] ${report.title}`;

  const htmlBody = `
<html>
<body style="font-family: monospace; background:#0d1117; color:#e6edf3; padding:24px;">
  <h2 style="color:#f85149;">${report.title}</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
    <tr><td style="padding:4px 12px 4px 0;color:#8b949e;">Time</td><td>${report.timestamp}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#8b949e;">Severity</td><td>${severity}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#8b949e;">URL</td><td>${report.url ?? "—"}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#8b949e;">Method</td><td>${report.method ?? "—"}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#8b949e;">App</td><td><a href="${appUrl}" style="color:#58a6ff;">${appUrl}</a></td></tr>
  </table>

  <h3 style="color:#e3b341;">Error Message</h3>
  <pre style="background:#161b22;padding:16px;border-radius:6px;overflow-x:auto;">${escapeHtml(report.message)}</pre>

  ${
    report.stack
      ? `<h3 style="color:#e3b341;">Stack Trace</h3>
  <pre style="background:#161b22;padding:16px;border-radius:6px;overflow-x:auto;font-size:12px;">${escapeHtml(report.stack)}</pre>`
      : ""
  }

  ${
    report.componentStack
      ? `<h3 style="color:#e3b341;">Component Stack</h3>
  <pre style="background:#161b22;padding:16px;border-radius:6px;overflow-x:auto;font-size:12px;">${escapeHtml(report.componentStack)}</pre>`
      : ""
  }

  ${
    report.context && Object.keys(report.context).length > 0
      ? `<h3 style="color:#e3b341;">Additional Context</h3>
  <pre style="background:#161b22;padding:16px;border-radius:6px;overflow-x:auto;">${escapeHtml(JSON.stringify(report.context, null, 2))}</pre>`
      : ""
  }
</body>
</html>
`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html: htmlBody,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[error-reporter] Resend API error:", res.status, text);
  } else {
    console.log("[error-reporter] Email alert sent for:", report.title);
  }
}

// ---------------------------------------------------------------------------
// GitHub issue creation
// ---------------------------------------------------------------------------

async function createGitHubIssue(report: ErrorReport): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. "acme/my-app"

  if (!token || !repo) {
    console.warn("[error-reporter] GitHub env vars missing — skipping issue creation");
    return null;
  }

  const severity = report.severity ?? "high";
  const labelMap: Record<string, string> = {
    low: "bug",
    medium: "bug",
    high: "bug,high-priority",
    critical: "bug,high-priority,critical",
  };

  const labels = (labelMap[severity] ?? "bug").split(",");

  const body = `## Error Report

**Severity:** \`${severity}\`
**Time:** ${report.timestamp}
**URL:** ${report.url ?? "—"}
**Method:** ${report.method ?? "—"}
**App:** ${process.env.NEXT_PUBLIC_APP_URL ?? "unknown"}

---

### Error Message

\`\`\`
${report.message}
\`\`\`

${
  report.stack
    ? `### Stack Trace

\`\`\`
${report.stack}
\`\`\``
    : ""
}

${
  report.componentStack
    ? `### Component Stack

\`\`\`
${report.componentStack}
\`\`\``
    : ""
}

${
  report.context && Object.keys(report.context).length > 0
    ? `### Additional Context

\`\`\`json
${JSON.stringify(report.context, null, 2)}
\`\`\``
    : ""
}

---
*Auto-created by the error monitoring pipeline. Do not edit the title — it is used for deduplication.*
`;

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `[${severity.toUpperCase()}] ${report.title}`,
      body,
      labels,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[error-reporter] GitHub API error:", res.status, text);
    return null;
  }

  const issue = await res.json();
  console.log("[error-reporter] GitHub issue created:", issue.html_url);
  return issue.html_url as string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Report an error through the full pipeline:
 *   1. Deduplicate within a 15-minute window
 *   2. Send email alert
 *   3. Create GitHub issue
 *
 * Safe to call from API routes, server actions, and middleware.
 * Never throws — all failures are logged, not propagated.
 */
export async function reportError(report: ErrorReport): Promise<void> {
  report.timestamp = report.timestamp ?? new Date().toISOString();
  report.severity = report.severity ?? "high";

  const key = deduplicationKey(report);

  if (isRecent(key)) {
    console.log("[error-reporter] Suppressing duplicate error:", report.title);
    return;
  }

  markSeen(key);

  // Fire both pipelines concurrently — failures in one don't block the other
  const results = await Promise.allSettled([
    sendEmailAlert(report),
    createGitHubIssue(report),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[error-reporter] Pipeline step failed:", result.reason);
    }
  }
}

/**
 * Convenience wrapper for Next.js API route errors.
 * Pulls the URL and method from the request automatically.
 */
export async function reportApiError(
  req: Request,
  error: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  await reportError({
    title: `API Error: ${err.message.slice(0, 100)}`,
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    severity: "high",
    context,
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
