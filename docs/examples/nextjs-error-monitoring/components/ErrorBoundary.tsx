"use client";

/**
 * ErrorBoundary.tsx
 *
 * A production-grade React error boundary for Next.js App Router.
 *
 * Features:
 *   - Reports errors to /api/report-error (which triggers email + GitHub issue)
 *   - Falls back to a friendly error UI instead of a blank page
 *   - Includes a "Try again" button to reset the boundary
 *   - Works in both client and server component trees
 *   - Captures component stack for easier debugging
 *
 * Usage — wrap any subtree you want to protect:
 *
 *   import { ErrorBoundary } from "@/components/ErrorBoundary";
 *
 *   export default function MyLayout({ children }) {
 *     return (
 *       <ErrorBoundary section="dashboard">
 *         {children}
 *       </ErrorBoundary>
 *     );
 *   }
 *
 * For Next.js App Router global error handling, also create
 * app/error.tsx and app/global-error.tsx (templates below).
 */

import React, { Component, type ErrorInfo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  children: ReactNode;
  /** Label for this boundary — helps identify which section errored */
  section?: string;
  /** Optional custom fallback UI */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  eventId: string | null;
}

// ---------------------------------------------------------------------------
// Client-side error reporting
// ---------------------------------------------------------------------------

async function reportToServer(
  error: Error,
  errorInfo: ErrorInfo,
  section: string
): Promise<void> {
  try {
    await fetch("/api/report-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Include the shared secret if available as an env var
        ...(process.env.NEXT_PUBLIC_ERROR_REPORT_SECRET
          ? { "x-error-report-secret": process.env.NEXT_PUBLIC_ERROR_REPORT_SECRET }
          : {}),
      },
      body: JSON.stringify({
        title: `[${section}] React Error: ${error.message.slice(0, 100)}`,
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
        url: window.location.href,
        severity: "high",
        context: {
          section,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
      }),
    });
  } catch (reportingError) {
    // Never let reporting errors surface to the user
    console.error("[ErrorBoundary] Failed to report error:", reportingError);
  }
}

// ---------------------------------------------------------------------------
// Default fallback UI
// ---------------------------------------------------------------------------

function DefaultFallback({
  error,
  eventId,
  onReset,
}: {
  error: Error;
  eventId: string | null;
  onReset: () => void;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "200px",
        padding: "32px",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: "48px", marginBottom: "16px" }}>⚠️</div>
      <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: "#111" }}>
        Something went wrong
      </h2>
      <p style={{ color: "#555", marginBottom: "24px", maxWidth: "400px" }}>
        We&apos;ve been notified and are looking into it. You can try refreshing
        this section or come back later.
      </p>
      {eventId && (
        <p style={{ color: "#888", fontSize: "12px", marginBottom: "16px" }}>
          Reference: {eventId}
        </p>
      )}
      <button
        onClick={onReset}
        style={{
          padding: "8px 20px",
          background: "#0070f3",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "14px",
        }}
      >
        Try again
      </button>
      {process.env.NODE_ENV === "development" && (
        <details
          style={{
            marginTop: "24px",
            textAlign: "left",
            maxWidth: "600px",
            width: "100%",
          }}
        >
          <summary style={{ cursor: "pointer", color: "#f00", fontSize: "13px" }}>
            Error details (dev only)
          </summary>
          <pre
            style={{
              background: "#1a1a1a",
              color: "#f8f8f2",
              padding: "12px",
              borderRadius: "4px",
              overflow: "auto",
              fontSize: "11px",
              marginTop: "8px",
            }}
          >
            {error.message}
            {"\n\n"}
            {error.stack}
          </pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBoundary class component (must be a class — React requirement)
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, eventId: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      // Simple unique ID for cross-referencing email/GitHub issue
      eventId: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const section = this.props.section ?? "app";
    console.error(`[ErrorBoundary:${section}]`, error, errorInfo);

    // Report asynchronously — don't block the error boundary render
    void reportToServer(error, errorInfo, section);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, eventId: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }
      return (
        <DefaultFallback
          error={this.state.error}
          eventId={this.state.eventId}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
