export type LocalProviderTimeout = number | false;

export const DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;

const GLOBAL_LOCAL_PROVIDER_TIMEOUT_ENV =
  "LETTA_CODE_LOCAL_PROVIDER_TIMEOUT_MS";

function normalizeProviderEnvStem(providerId: string): string {
  return providerId
    .replace(/^lc-/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function timeoutEnvNames(providerIds: readonly string[]): string[] {
  const names = new Set<string>();
  for (const providerId of providerIds) {
    const stem = normalizeProviderEnvStem(providerId);
    if (!stem) continue;
    names.add(`LETTA_CODE_${stem}_TIMEOUT_MS`);
    names.add(`${stem}_TIMEOUT_MS`);
  }
  names.add(GLOBAL_LOCAL_PROVIDER_TIMEOUT_ENV);
  return [...names];
}

export function parseLocalProviderTimeout(
  value: string | undefined,
): LocalProviderTimeout | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "off", "none", "disabled", "disable"].includes(normalized)) {
    return false;
  }

  const match = normalized.match(
    /^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid local provider timeout "${value}". Use milliseconds, a duration like 600s or 10m, or false to disable.`,
    );
  }

  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `Invalid local provider timeout "${value}". Timeout must be greater than zero, or false to disable.`,
    );
  }

  const unit = match[2] ?? "ms";
  const multiplier =
    unit.startsWith("m") && unit !== "ms" ? 60_000 : unit === "ms" ? 1 : 1_000;
  return Math.round(amount * multiplier);
}

export function resolveLocalProviderTimeout(options: {
  configuredTimeout?: LocalProviderTimeout;
  providerIds?: readonly string[];
  fallback?: LocalProviderTimeout;
}): LocalProviderTimeout {
  if (options.configuredTimeout !== undefined) return options.configuredTimeout;

  for (const envName of timeoutEnvNames(options.providerIds ?? [])) {
    const parsed = parseLocalProviderTimeout(process.env[envName]);
    if (parsed !== undefined) return parsed;
  }

  return options.fallback ?? DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

export function createLocalProviderFetch(options: {
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): typeof fetch {
  const baseFetch = options.fetch ?? fetch;
  const timeout = resolveLocalProviderTimeout({
    configuredTimeout: options.timeout,
  });

  return (async (input, init) => {
    const signals: AbortSignal[] = [];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    if (timeout !== false) signals.push(AbortSignal.timeout(timeout));
    const signal = combineAbortSignals(signals);
    const nextInit = {
      ...init,
      ...(signal ? { signal } : {}),
      // Bun has its own transport timeout. Match OpenCode by disabling it and
      // using our provider-level AbortSignal timeout instead.
      timeout: false,
    } as RequestInit & { timeout: false };
    return baseFetch(input, nextInit);
  }) as typeof fetch;
}

export function formatLocalProviderTimeout(
  timeout: LocalProviderTimeout,
): string {
  return timeout === false ? "disabled" : `${timeout}ms`;
}
