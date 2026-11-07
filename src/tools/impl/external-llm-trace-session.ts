import {
  type ApiRequestConfig,
  apiRequest,
  getApiRequestConfig,
} from "@/backend/api/request";
import { resolveBackendMode } from "@/backend/backend-mode";
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
  try {
    const config = await deps.getConfig({
      signal: AbortSignal.timeout(5000),
    });
    if (!traceCaptureEnabled(env, config.baseUrl, config.apiKey))
      return undefined;
    const { actingUserId: _actingUserId, secretValues = [], ...ids } = context;
    const scope = { ...ids, worker_session_id: workerSessionId };
    sessionScopes.set(workerSessionId, scope);
    const queue: ExternalTraceRow[] = [];
    let bytes = 0;
    let draining: Promise<void> | undefined;
    let closed = false;
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
          let size = 0;
          for (const row of queue) {
            const next = Buffer.byteLength(JSON.stringify(row));
            if (
              batch.length &&
              (size + next > 7 * 1024 * 1024 || batch.length === 20)
            )
              break;
            batch.push(row);
            size += next;
          }
          let success = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await deps.upload(batch, config, context);
              success = true;
              break;
            } catch {
              if (attempt < 2)
                await new Promise((resolve) =>
                  setTimeout(resolve, 250 * 2 ** attempt),
                );
            }
          }
          // Best effort: keep no unbounded spool or sensitive errors in logs.
          queue.splice(0, batch.length);
          bytes -= size;
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
      emit: (row) => {
        if (
          closed ||
          !traceCaptureEnabled(process.env, config.baseUrl, config.apiKey)
        )
          return;
        if (Buffer.byteLength(JSON.stringify(row)) > 7 * 1024 * 1024) {
          row.request_json = row.response_json = '{"omitted":"size_limit"}';
          row.capture_status = "size_limit";
        }
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > 64 * 1024 * 1024) return;
        queue.push(row);
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
  } catch {
    return undefined;
  }
}
