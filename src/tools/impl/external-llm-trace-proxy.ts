import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isDeepStrictEqual } from "node:util";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import {
  assembleTraceResponse,
  compactTracePayload,
  MAX_TRACE_BUFFER_BYTES,
  sanitizeTraceJson,
  TRUNCATED_TRACE_JSON,
  tracePayloadFits,
} from "./external-llm-trace-payload";

export interface ExternalTraceScope {
  parent_agent_id: string;
  parent_conversation_id: string;
  task_id: string;
  task_description?: string;
  worker_session_id: string;
}
export interface ExternalTraceRow extends ExternalTraceScope {
  id: string;
  harness: "claude_code" | "codex";
  model: string;
  request_json: string;
  response_json: string;
  request_size_bytes: number;
  response_size_bytes: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  status: number;
  is_error: number;
  error_type: string;
  error_message: string;
  capture_status: string;
  created_at: string;
}

export async function startTraceProxy(options: {
  upstream: string;
  harness: ExternalTraceRow["harness"];
  scope: ExternalTraceScope;
  secrets: string[];
  emit: (
    row: ExternalTraceRow,
    delta?: { baseId: string; fallbackJson: string },
  ) => void;
}) {
  const upstream = new URL(options.upstream);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password
  )
    throw new Error("Unsupported trace upstream");
  const prefix = `/${randomUUID()}`;
  const historyKey = options.harness === "claude_code" ? "messages" : "input";
  let previous: { id: string; sessionId: string; items: unknown[] } | undefined;
  let activeCaptures = 0;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(`${prefix}/`)) {
      res.writeHead(404).end();
      return;
    }
    const path =
      upstream.pathname.replace(/\/$/, "") + req.url.slice(prefix.length);
    const capture =
      req.method === "POST" &&
      /\/(messages|responses|compact)(\?|$)/.test(path);
    const captureBody = activeCaptures < 8;
    if (capture) activeCaptures++;
    const scope = { ...options.scope };
    const started = Date.now();
    const created = new Date().toISOString();
    let requestBytes = 0,
      responseBytes = 0;
    const requestChunks: Buffer[] = [],
      responseChunks: Buffer[] = [];
    let encoding = "";
    let status = 0,
      streaming = false,
      finished = false;
    const credentials = [...options.secrets];
    for (const name of ["authorization", "x-api-key", "cookie"]) {
      const header = req.headers[name];
      if (typeof header === "string") {
        credentials.push(header);
        if (name === "authorization")
          credentials.push(header.replace(/^Bearer\s+/i, ""));
      }
    }
    const finish = (transportError = false) => {
      if (finished) return;
      finished = true;
      if (!capture) return;
      const work = new Promise<void>((resolve) =>
        setImmediate(() => {
          try {
            processCapture(transportError);
          } catch {
          } finally {
            activeCaptures--;
            resolve();
          }
        }),
      );
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    const processCapture = (transportError: boolean) => {
      const id = randomUUID();
      const requestBuffered =
        captureBody && requestBytes <= MAX_TRACE_BUFFER_BYTES;
      let responseBuffered =
        captureBody && responseBytes <= MAX_TRACE_BUFFER_BYTES;
      let responseRaw = Buffer.concat(responseChunks);
      try {
        const decoder =
          encoding === "gzip"
            ? gunzipSync
            : encoding === "deflate"
              ? inflateSync
              : encoding === "br"
                ? brotliDecompressSync
                : undefined;
        if (decoder && responseBuffered)
          responseRaw = decoder(responseRaw, {
            maxOutputLength: MAX_TRACE_BUFFER_BYTES,
          });
      } catch {
        responseBuffered = false;
      }
      const responseText = responseBuffered ? responseRaw.toString("utf8") : "";
      streaming ||= /(?:^|\r?\n)data:/.test(responseText);
      const assembled = assembleTraceResponse(responseText, streaming);
      let responseJson = responseBuffered
        ? sanitizeTraceJson(
            JSON.stringify(streaming ? assembled : assembled.response),
            credentials,
          )
        : TRUNCATED_TRACE_JSON;
      const responseTruncated =
        !responseBuffered || !tracePayloadFits(responseJson);
      if (responseBuffered && responseTruncated)
        responseJson = compactTracePayload(responseJson);

      let requestJson = requestBuffered
        ? sanitizeTraceJson(
            Buffer.concat(requestChunks).toString("utf8"),
            credentials,
          )
        : TRUNCATED_TRACE_JSON;
      const request = JSON.parse(requestJson) as Record<string, unknown> | null;
      const items = request?.[historyKey];
      const requestTruncated =
        !requestBuffered || !tracePayloadFits(requestJson);
      let delta: { baseId: string; fallbackJson: string } | undefined;
      if (requestBuffered && requestTruncated) {
        const fallbackJson = compactTracePayload(requestJson);
        requestJson = fallbackJson;
        if (
          previous?.sessionId === scope.worker_session_id &&
          Array.isArray(items)
        ) {
          const prefixItems = previous.items.length;
          if (
            prefixItems > 0 &&
            items.length > prefixItems &&
            previous.items.every((item, index) =>
              isDeepStrictEqual(item, items[index]),
            )
          ) {
            const deltaJson = JSON.stringify({
              ...request,
              [historyKey]: items.slice(prefixItems),
              base_trace_id: previous.id,
              prefix_items: prefixItems,
            });
            if (tracePayloadFits(deltaJson)) {
              requestJson = deltaJson;
              delta = { baseId: previous.id, fallbackJson };
            }
          }
        }
      }
      previous =
        Array.isArray(items) && (!requestTruncated || delta)
          ? { id, sessionId: scope.worker_session_id, items }
          : undefined;
      const response = assembled.response;
      const usage = response.usage ?? {};
      const token = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.min(Math.trunc(value), 0xffffffff)
          : null;
      const cached = token(
        usage.cache_read_input_tokens ??
          usage.input_tokens_details?.cached_tokens,
      );
      const written = token(usage.cache_creation_input_tokens);
      let input = token(usage.input_tokens);
      if (options.harness === "claude_code" && input !== null)
        input = token(input + (cached ?? 0) + (written ?? 0));
      const output = token(usage.output_tokens);
      const error =
        transportError ||
        status >= 400 ||
        Boolean(response.error) ||
        response.status === "failed";
      options.emit(
        {
          ...scope,
          task_description:
            scope.task_description === undefined
              ? undefined
              : JSON.parse(
                  sanitizeTraceJson(
                    JSON.stringify(scope.task_description),
                    credentials,
                  ),
                ),
          id,
          harness: options.harness,
          model: JSON.parse(
            sanitizeTraceJson(
              JSON.stringify(String(response.model ?? request?.model ?? "")),
              credentials,
            ),
          ).slice(0, 255),
          request_json: requestJson,
          response_json: responseJson,
          request_size_bytes: Math.min(requestBytes, 0xffffffff),
          response_size_bytes: Math.min(responseBytes, 0xffffffff),
          prompt_tokens: input,
          completion_tokens: output,
          total_tokens:
            input !== null && output !== null ? token(input + output) : null,
          cached_input_tokens: cached,
          cache_write_tokens: written,
          reasoning_tokens: token(
            usage.output_tokens_details?.reasoning_tokens,
          ),
          cost_usd: null,
          latency_ms: Math.min(Date.now() - started, 0xffffffff),
          status,
          is_error: error ? 1 : 0,
          error_type: transportError
            ? "transport_error"
            : error
              ? "provider_error"
              : "",
          error_message: "",
          capture_status: delta
            ? "delta"
            : requestTruncated || responseTruncated
              ? "size_limit"
              : transportError || !assembled.complete
                ? "incomplete"
                : "complete",
          created_at: created,
        },
        delta,
      );
    };
    const headers = {
      ...req.headers,
      host: upstream.host,
    };
    const target = (
      upstream.protocol === "https:" ? httpsRequest : httpRequest
    )(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path,
        method: req.method,
        headers,
      },
      (reply) => {
        status = reply.statusCode ?? 502;
        encoding = String(reply.headers["content-encoding"] ?? "");
        streaming = String(reply.headers["content-type"]).includes(
          "text/event-stream",
        );
        res.writeHead(status, reply.headers);
        reply.on("data", (chunk: Buffer) => {
          if (!capture) return;
          responseBytes += chunk.length;
          if (captureBody && responseBytes <= MAX_TRACE_BUFFER_BYTES)
            responseChunks.push(Buffer.from(chunk));
          else responseChunks.length = 0;
        });
        reply.on("end", () => finish());
        reply.on("error", () => {
          finish(true);
          res.destroy();
        });
        reply.pipe(res);
      },
    );
    target.on("error", () => {
      finish(true);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("data", (chunk: Buffer) => {
      if (!capture) return;
      requestBytes += chunk.length;
      if (captureBody && requestBytes <= MAX_TRACE_BUFFER_BYTES)
        requestChunks.push(Buffer.from(chunk));
      else requestChunks.length = 0;
    });
    req.on("aborted", () => {
      finish(true);
      target.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        finish(true);
        target.destroy();
      }
    });
    req.pipe(target);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Trace proxy failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}${prefix}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.all(pending);
    },
  };
}
