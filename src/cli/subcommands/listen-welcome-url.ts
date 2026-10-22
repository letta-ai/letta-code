/**
 * First-run welcome URL: when computer registration returns an optional
 * `welcomeUrl`, the listener opens it in this computer's default browser and
 * tells the server what happened, so the server does not have to drive the
 * computer remotely just to open a page.
 *
 * Everything here is best-effort. A failure never blocks or stops the
 * listener; it only changes the result reported back to the server.
 */

import type { ChildProcess } from "node:child_process";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";

/** Set to "1" or "true" to never open the first-run welcome URL. */
export const WELCOME_URL_OPT_OUT_ENV = "LETTA_DISABLE_WELCOME_URL";

/** Reported values: `opened`, `skipped:<reason>`, or `failed:<reason>`. */
export type WelcomeUrlResult =
  | "opened"
  | `skipped:${string}`
  | `failed:${string}`;

export type WelcomeOpenDecision =
  | { open: true }
  | { open: false; reason: "opted-out" | "ssh" | "headless" };

/**
 * Whether a browser opened here would appear in front of the person who ran
 * the command. Over SSH, or on a Linux machine with no display server, it
 * would open (or fail to open) somewhere they cannot see.
 */
export function decideWelcomeOpen(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WelcomeOpenDecision {
  const optOut = env[WELCOME_URL_OPT_OUT_ENV]?.trim().toLowerCase();
  if (optOut === "1" || optOut === "true") {
    return { open: false, reason: "opted-out" };
  }
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return { open: false, reason: "ssh" };
  }
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { open: false, reason: "headless" };
  }
  return { open: true };
}

/** Uses the `open` package: macOS `open`, Windows `start`, Linux `xdg-open`. */
export type BrowserOpener = (url: string) => Promise<ChildProcess>;

const defaultOpener: BrowserOpener = async (url) => {
  const { default: open } = await import("open");
  return open(url, { wait: false });
};

/**
 * How long to watch the opener before calling it a success. macOS `open` and
 * a typical `xdg-open` exit well within this; an opener still running after
 * it has handed the URL to a browser that stays attached.
 */
const OPENER_SETTLE_MS = 1_500;

function reasonFrom(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code || "error";
}

/**
 * Open the URL with the platform opener and classify the outcome. Resolves
 * as soon as the opener exits, errors, or has run for `settleMs`.
 */
export async function openWelcomeUrl(
  url: string,
  opener: BrowserOpener = defaultOpener,
  settleMs: number = OPENER_SETTLE_MS,
): Promise<WelcomeUrlResult> {
  let subprocess: ChildProcess;
  try {
    subprocess = await opener(url);
  } catch (error) {
    return `failed:${reasonFrom(error)}`;
  }
  return new Promise<WelcomeUrlResult>((resolve) => {
    const timer = setTimeout(() => resolve("opened"), settleMs);
    timer.unref?.();
    subprocess.once("error", (error) => {
      clearTimeout(timer);
      resolve(`failed:${reasonFrom(error)}`);
    });
    subprocess.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? "opened" : `failed:exit-${code ?? signal}`);
    });
  });
}

export interface WelcomeUrlReportOptions {
  serverUrl: string;
  apiKey: string;
  connectionId: string;
}

/**
 * Tell the server how the welcome URL went. Only sent when the server offered
 * a `welcomeUrl`, so servers without the endpoint are never called. Returns
 * whether the server accepted the report.
 */
export async function reportWelcomeUrlResult(
  opts: WelcomeUrlReportOptions,
  result: WelcomeUrlResult,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${opts.serverUrl}/v1/environments/${encodeURIComponent(opts.connectionId)}/welcome-result`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getDesktopAccessToken() ?? opts.apiKey}`,
          "X-Letta-Source": "letta-code",
        },
        body: JSON.stringify({ result }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Decide, open when appropriate, and report. Never throws.
 */
export async function handleWelcomeUrl(
  welcomeUrl: string,
  report: WelcomeUrlReportOptions,
  deps: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    opener?: BrowserOpener;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WelcomeUrlResult> {
  const decision = decideWelcomeOpen(deps.env, deps.platform);
  const result: WelcomeUrlResult = decision.open
    ? await openWelcomeUrl(welcomeUrl, deps.opener)
    : `skipped:${decision.reason}`;
  await reportWelcomeUrlResult(report, result, deps.fetchImpl);
  return result;
}
