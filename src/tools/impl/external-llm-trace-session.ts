import {
  type ApiRequestConfig,
  ApiRequestError,
  apiRequest,
  getApiRequestConfig,
} from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
import { debugWarn } from "@/utils/debug";
import { traceCaptureEnabled } from "./external-llm-trace-payload";
import {
  type ExternalTraceRow,
  type ExternalTraceScope,
  startTraceProxy,
} from "./external-llm-trace-proxy";

export type ExternalTraceContext = Omit<
  ExternalTraceScope,
  "worker_session_id"
> & { actingUserId?: string | null; secretValues?: string[] };

const sessionScopes = new Map<string, ExternalTraceScope>();
export function updateExternalTraceTask(
  sessionId: string,
  context: ExternalTraceContext | undefined,
): void {
  const scope = sessionScopes.get(sessionId);
  if (
    scope &&
    context &&
    scope.parent_agent_id === context.parent_agent_id &&
    scope.parent_conversation_id === context.parent_conversation_id
  )
    scope.task_id = context.task_id;
}

interface TraceSessionDependencies {
  getConfig: typeof getApiRequestConfig;
  upload(
    rows: ExternalTraceRow[],
    config: ApiRequestConfig,
    context: ExternalTraceContext,
  ): Promise<void>;
  warn?: (message: string) => void;
}

const WARN_INTERVAL_MS = 60_000;
const MAX_TRACE_BATCH_BYTES = 8 * 1024 * 1024;
const TRACE_BATCH_ENVELOPE_BYTES = Buffer.byteLength('{"rows":[]}');

/** Status (or error name) plus a short server message; never request bodies or headers. */
function describeUploadError(error: unknown, secrets: string[]): string {
  if (!(error instanceof Error)) return "error=unknown";
  if (!(error instanceof ApiRequestError)) return `error=${error.name}`;
  let detail = error.responseText;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const field = parsed.detail ?? parsed.message ?? parsed.error;
    detail = typeof field === "string" ? field : JSON.stringify(field ?? "");
  } catch {
    // Non-JSON body: keep the raw text.
  }
  for (const secret of secrets)
    if (secret.length >= 4) detail = detail.split(secret).join("[redacted]");
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 200) detail = `${detail.slice(0, 200)}…`;
  return detail
    ? `status=${error.status} message=${JSON.stringify(detail)}`
    : `status=${error.status}`;
}

const productionDependencies: TraceSessionDependencies = {
  getConfig: getApiRequestConfig,
  async upload(rows, config, context) {
    await apiRequest(
      "POST",
      `/v1/conversations/${encodeURIComponent(context.parent_conversation_id)}/llm-trace`,
      { rows },
      {
        ...config,
        actingUserId: context.actingUserId,
        signal: AbortSignal.timeout(10000),
      },
    );
  },
};

/** A session owns its proxy and bounded upload queue until the CLI process exits. */
export async function createTraceSession(
  harness: ExternalTraceRow["harness"],
  context: ExternalTraceContext | undefined,
  env: NodeJS.ProcessEnv,
  upstream: string,
  workerSessionId = "pending",
  deps: TraceSessionDependencies = productionDependencies,
) {
  if (
    !context ||
    resolveBackendMode() !== "api" ||
    env.LETTA_CODE_TELEM === "0" ||
    env.LETTA_CODE_TELEM === "false" ||
    env.DO_NOT_TRACK === "1"
  )
    return undefined;
  const warn =
    deps.warn ?? ((message: string) => debugWarn("llm-trace", message));
  try {
    const config = await deps.getConfig({
      signal: AbortSignal.timeout(5000),
    });
    if (!traceCaptureEnabled(env, config.baseUrl, config.apiKey))
      return undefined;
    const { actingUserId: _actingUserId, secretValues = [], ...ids } = context;
    const scope = { ...ids, worker_session_id: workerSessionId };
    sessionScopes.set(workerSessionId, scope);
    const queue: {
      row: ExternalTraceRow;
      delta?: { baseId: string; fallbackJson: string };
      size: number;
    }[] = [];
    let uploadedBaseId: string | undefined;
    let bytes = 0;
    let draining: Promise<void> | undefined;
    let closed = false;
    let lastWarnAt = Number.NEGATIVE_INFINITY;
    const flush = (): Promise<void> => {
      if (draining) return draining;
      draining = (async () => {
        while (queue.length) {
          if (
            !traceCaptureEnabled(process.env, config.baseUrl, config.apiKey)
          ) {
            queue.length = 0;
            bytes = 0;
            break;
          }
          const batch: ExternalTraceRow[] = [];
          let batchBytes = TRACE_BATCH_ENVELOPE_BYTES;
          let baseId = uploadedBaseId;
          let queuedBytes = 0;
          for (const entry of queue) {
            // A delta is usable only if its base was uploaded or is in this batch.
            const fallback =
              entry.delta?.baseId !== baseId ? entry.delta : undefined;
            const row: ExternalTraceRow = fallback
              ? {
                  ...entry.row,
                  request_json: fallback.fallbackJson,
                  capture_status: "size_limit",
                }
              : entry.row;
            const nextBytes =
              Buffer.byteLength(JSON.stringify(row)) + (batch.length ? 1 : 0);
            if (
              batchBytes + nextBytes > MAX_TRACE_BATCH_BYTES ||
              batch.length === 20
            )
              break;
            batch.push(row);
            batchBytes += nextBytes;
            queuedBytes += entry.size;
            baseId = fallback ? undefined : row.id;
          }
          let success = false;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await deps.upload(batch, config, context);
              success = true;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < 2)
                await new Promise((resolve) =>
                  setTimeout(resolve, 250 * 2 ** attempt),
                );
            }
          }
          // Best effort: drop the batch, and log at most one warning per
          // interval with metadata only (no trace contents or credentials).
          if (!success && Date.now() - lastWarnAt >= WARN_INTERVAL_MS) {
            lastWarnAt = Date.now();
            warn(
              `External trace upload failed: ${describeUploadError(lastError, secrets)} rows=${batch.length} harness=${harness} conversation=${context.parent_conversation_id}`,
            );
          }
          queue.splice(0, batch.length);
          bytes -= queuedBytes;
          if (success) uploadedBaseId = baseId;
          if (!success && closed) {
            queue.length = 0;
            bytes = 0;
            break;
          }
        }
      })().finally(() => {
        draining = undefined;
      });
      return draining;
    };
    const secrets = [
      config.apiKey,
      ...secretValues,
      ...Object.entries(env)
        .filter(([key]) => /token|secret|password|api[_-]?key/i.test(key))
        .map(([, value]) => value ?? ""),
    ];
    const proxy = await startTraceProxy({
      upstream,
      harness,
      scope,
      secrets,
      emit: (row, delta) => {
        if (
          closed ||
          !traceCaptureEnabled(process.env, config.baseUrl, config.apiKey)
        )
          return;
        const rowBytes = Buffer.byteLength(JSON.stringify(row));
        const fallbackBytes = delta
          ? Buffer.byteLength(
              JSON.stringify({
                ...row,
                request_json: delta.fallbackJson,
                capture_status: "size_limit",
              }),
            )
          : 0;
        if (
          Math.max(rowBytes, fallbackBytes) + TRACE_BATCH_ENVELOPE_BYTES >
          MAX_TRACE_BATCH_BYTES
        )
          return;
        const size =
          rowBytes + (delta ? Buffer.byteLength(delta.fallbackJson) : 0);
        if (bytes + size > 64 * 1024 * 1024) return;
        queue.push({ row, delta, size });
        bytes += size;
        if (queue.length >= 10) void flush();
      },
    });
    const timer = setInterval(() => void flush(), 2000);
    timer.unref();
    return {
      url: proxy.url,
      baseUrl: config.baseUrl,
      setSessionId: (id: string) => {
        if (sessionScopes.get(scope.worker_session_id) === scope)
          sessionScopes.delete(scope.worker_session_id);
        scope.worker_session_id = id;
        sessionScopes.set(id, scope);
      },
      close: async () => {
        if (sessionScopes.get(scope.worker_session_id) === scope)
          sessionScopes.delete(scope.worker_session_id);
        await proxy.close();
        closed = true;
        clearInterval(timer);
        await flush();
      },
    };
  } catch (error) {
    warn(
      `External trace session setup failed: error=${error instanceof Error ? error.name : "unknown"} harness=${harness} conversation=${context.parent_conversation_id}`,
    );
    return undefined;
  }
}
