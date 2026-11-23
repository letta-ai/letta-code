import { apiRequest } from "@/backend/api/request";

const DEFAULT_KEEPALIVE_INTERVAL_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_RETRY_DELAYS_MS = [15_000, 30_000] as const;
const VERIFY_TIMEOUT_MS = 30_000;

type VerifyResult = { valid: boolean };
type VerifyFn = (token: string, signal: AbortSignal) => Promise<VerifyResult>;

const defaultVerify: VerifyFn = async (token, signal) =>
  apiRequest<VerifyResult>(
    "POST",
    "/v1/mcp-originator-tokens/verify",
    { token },
    { signal },
  );

let verifyImpl: VerifyFn = defaultVerify;
let intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS;
let verifyTimeoutMs = VERIFY_TIMEOUT_MS;

type KeepaliveEntry = {
  timer: ReturnType<typeof setTimeout> | undefined;
  consecutiveFailures: number;
  ticking: boolean;
  verifyAsap: boolean;
  hooks?: KeepaliveHooks;
};

export type KeepaliveHooks = {
  getToken: () => string | undefined;
  withdraw: () => void;
};

const keepalives = new Map<string, KeepaliveEntry>();

let schedulingEnabled = process.env.NODE_ENV !== "test";

async function runKeepaliveTick(superRunId: string): Promise<void> {
  const entry = keepalives.get(superRunId);
  if (!entry || entry.ticking) return;
  const token = entry.hooks?.getToken();
  if (!token) {
    stopMcpOriginatorKeepalive(superRunId);
    return;
  }
  entry.ticking = true;
  try {
    const result = await verifyWithHardBound(token, verifyTimeoutMs);
    if (entry.hooks?.getToken() !== token) {
      return;
    }
    entry.consecutiveFailures = 0;
    if (!result.valid) {
      console.warn(
        `[mcp-originator-keepalive] server denied the originator token for super run ${superRunId}; withdrawing it (turn continues unattributed)`,
      );
      entry.hooks?.withdraw();
      stopMcpOriginatorKeepalive(superRunId);
      return;
    }
  } catch (error) {
    if (entry.hooks?.getToken() !== token) {
      return;
    }
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[mcp-originator-keepalive] renewal failed ${entry.consecutiveFailures} times for super run ${superRunId}; stopping renewal (the server-side TTL now bounds the token):`,
        error instanceof Error ? error.message : error,
      );
      stopMcpOriginatorKeepalive(superRunId);
      return;
    }
  } finally {
    entry.ticking = false;
    if (schedulingEnabled && keepalives.get(superRunId) === entry) {
      const delay = entry.verifyAsap
        ? 0
        : nextDelayMs(entry.consecutiveFailures);
      entry.verifyAsap = false;
      entry.timer = setTimeout(() => {
        void runKeepaliveTick(superRunId);
      }, delay);
      entry.timer?.unref();
    }
  }
}

function nextDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return intervalMs;
  const lastDelay = FAILURE_RETRY_DELAYS_MS[FAILURE_RETRY_DELAYS_MS.length - 1];
  return (
    FAILURE_RETRY_DELAYS_MS[
      Math.min(consecutiveFailures, FAILURE_RETRY_DELAYS_MS.length) - 1
    ] ??
    lastDelay ??
    intervalMs
  );
}

function verifyWithHardBound(
  token: string,
  budgetMs: number,
): Promise<VerifyResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `[mcp-originator-keepalive] verify exceeded the ${budgetMs}ms hard bound`,
        ),
      );
    }, budgetMs);
    verifyImpl(token, AbortSignal.timeout(budgetMs)).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function startMcpOriginatorKeepalive(
  superRunId: string,
  hooks: KeepaliveHooks,
): void {
  const existing = keepalives.get(superRunId);
  if (existing) {
    existing.hooks = hooks;
    existing.consecutiveFailures = 0;
    existing.verifyAsap = true;
    if (schedulingEnabled && !existing.ticking) {
      clearTimeout(existing.timer);
      existing.verifyAsap = false;
      existing.timer = setTimeout(() => {
        void runKeepaliveTick(superRunId);
      }, 0);
      existing.timer?.unref();
    }
    return;
  }
  const entry: KeepaliveEntry = {
    timer: schedulingEnabled
      ? setTimeout(() => {
          void runKeepaliveTick(superRunId);
        }, 0)
      : undefined,
    consecutiveFailures: 0,
    ticking: false,
    verifyAsap: false,
    hooks,
  };
  entry.timer?.unref();
  keepalives.set(superRunId, entry);
}

export function stopMcpOriginatorKeepalive(superRunId: string): void {
  const entry = keepalives.get(superRunId);
  if (!entry) return;
  clearTimeout(entry.timer);
  keepalives.delete(superRunId);
}

export function stopAllMcpOriginatorKeepalives(): void {
  for (const runId of [...keepalives.keys()]) {
    stopMcpOriginatorKeepalive(runId);
  }
}

export function configureMcpOriginatorKeepaliveForTests(
  config: {
    verify?: VerifyFn;
    intervalMs?: number;
    verifyTimeoutMs?: number;
  } | null,
): void {
  stopAllMcpOriginatorKeepalives();
  verifyImpl = config?.verify ?? defaultVerify;
  intervalMs = config?.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  verifyTimeoutMs = config?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  schedulingEnabled = false;
}

export async function runMcpOriginatorKeepaliveTickForTests(
  superRunId: string,
): Promise<void> {
  if (!keepalives.has(superRunId)) {
    keepalives.set(superRunId, {
      timer: undefined,
      consecutiveFailures: 0,
      ticking: false,
      verifyAsap: false,
    });
  }
  await runKeepaliveTick(superRunId);
}

export function hasMcpOriginatorKeepaliveForTests(superRunId: string): boolean {
  return keepalives.has(superRunId);
}
