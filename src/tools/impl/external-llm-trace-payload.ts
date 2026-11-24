import { isCloudServerUrl } from "@/backend/api/server-url";

export const MAX_TRACE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const SENSITIVE =
  /^(authorization|proxy-authorization|x-api-key|api[_-]?key|cookies?|set-cookie|x-auth-token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)$/i;
type JsonObject = Record<string, any>;

export function traceCaptureEnabled(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  apiKey: string,
): boolean {
  return (
    env.LETTA_CODE_TELEM !== "0" &&
    env.LETTA_CODE_TELEM !== "false" &&
    env.DO_NOT_TRACK !== "1" &&
    isCloudServerUrl(baseUrl) &&
    Boolean(apiKey)
  );
}

export function sanitizeTraceJson(raw: string, secrets: string[]): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return JSON.stringify({ omitted: "invalid_json" });
  }
  return JSON.stringify(value, (key, candidate: unknown) => {
    if (SENSITIVE.test(key)) return "[REDACTED]";
    if (typeof candidate !== "string") return candidate;
    for (const secret of secrets)
      if (secret)
        candidate = (candidate as string).split(secret).join("[REDACTED]");
    return candidate;
  });
}

function assembleResponse(
  raw: string,
  streaming: boolean,
): { response: JsonObject; events: JsonObject[]; complete: boolean } {
  if (!streaming) {
    try {
      const response = JSON.parse(raw);
      if (!response || typeof response !== "object" || Array.isArray(response))
        return { response: {}, events: [], complete: false };
      return { response, events: [], complete: true };
    } catch {
      return { response: {}, events: [], complete: false };
    }
  }
  const events: JsonObject[] = [];
  let response: JsonObject = {};
  let complete = false;
  const inputs = new Map<number, string>();
  for (const frame of raw.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: JsonObject;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    events.push(event);
    if (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      response = event.response ?? {};
      complete = true;
    }
    if (event.type === "message_start")
      response = structuredClone(event.message);
    if (
      String(event.type).startsWith("content_block_") &&
      (!Number.isInteger(event.index) ||
        event.index < 0 ||
        event.index > events.length)
    )
      throw new Error("Invalid content block index");
    if (event.type === "content_block_start") {
      response.content ??= [];
      response.content[event.index] = structuredClone(event.content_block);
    }
    if (event.type === "content_block_delta") {
      const block = response.content?.[event.index];
      const delta = event.delta;
      if (!block || !delta) continue;
      if (delta.type === "text_delta")
        block.text = (block.text ?? "") + delta.text;
      if (delta.type === "thinking_delta")
        block.thinking = (block.thinking ?? "") + delta.thinking;
      if (delta.type === "signature_delta")
        block.signature = (block.signature ?? "") + delta.signature;
      if (delta.type === "input_json_delta")
        inputs.set(
          event.index,
          (inputs.get(event.index) ?? "") + delta.partial_json,
        );
    }
    if (event.type === "message_delta") {
      Object.assign(response, event.delta);
      response.usage = { ...response.usage, ...event.usage };
    }
    if (event.type === "message_stop") complete = true;
    if (event.type === "error") {
      response.error = event.error;
      complete = true;
    }
  }
  for (const [index, input] of inputs) {
    try {
      response.content[index].input = JSON.parse(input);
    } catch {
      complete = false;
    }
  }
  return { response, events, complete };
}

export function assembleTraceResponse(
  raw: string,
  streaming: boolean,
): ReturnType<typeof assembleResponse> {
  try {
    return assembleResponse(raw, streaming);
  } catch {
    return {
      response: { omitted: "malformed_response" },
      events: [],
      complete: false,
    };
  }
}

export const MAX_TRACE_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_PAYLOAD_BYTES = 3 * 1024 * 1024;
const truncated = { truncated: "size_limit" };
export const TRUNCATED_TRACE_JSON = JSON.stringify(truncated);

function traceJsonFits(bytes: number, encodedBytes: number): boolean {
  return (
    bytes <= MAX_TRACE_PAYLOAD_BYTES &&
    encodedBytes <= MAX_ENCODED_PAYLOAD_BYTES
  );
}

export function tracePayloadFits(json: string): boolean {
  return traceJsonFits(
    Buffer.byteLength(json),
    Buffer.byteLength(JSON.stringify(json)),
  );
}

function isInlineImage(value: JsonObject): boolean {
  if (value.type === "image")
    return (
      value.source?.type === "base64" && typeof value.source.data === "string"
    );
  const url =
    typeof value.image_url === "string"
      ? value.image_url
      : value.image_url?.url;
  return (
    (value.type === "input_image" || value.type === "image_url") &&
    typeof url === "string" &&
    /^data:image\/[^;,]+;base64,/i.test(url)
  );
}

export function compactTracePayload(
  json: string,
  mode: "full" | "images" = "full",
): string {
  const payload: unknown = JSON.parse(json);
  if (!payload || typeof payload !== "object") return TRUNCATED_TRACE_JSON;
  if (mode === "full" && !Array.isArray(payload)) {
    const object = payload as Record<string, unknown>;
    delete object.system;
    delete object.tools;
    delete object.truncated;
  }
  const marked = () =>
    JSON.stringify(
      Array.isArray(payload)
        ? { items: payload, ...truncated }
        : { ...payload, ...truncated },
    );
  const initial = marked();
  let bytes = Buffer.byteLength(initial);
  let encodedBytes = Buffer.byteLength(JSON.stringify(initial));
  if (traceJsonFits(bytes, encodedBytes)) return initial;

  function shrink(imagesOnly: boolean) {
    const candidates: {
      bytes: number;
      encodedBytes: number;
      replace: () => void;
    }[] = [];
    function collect(container: Record<string, unknown> | unknown[]) {
      for (const [key, value] of Object.entries(container)) {
        const isObject = value !== null && typeof value === "object";
        if (imagesOnly && (!isObject || !isInlineImage(value as JsonObject))) {
          if (isObject) collect(value as Record<string, unknown>);
          continue;
        }
        if (
          !imagesOnly &&
          (Array.isArray(value) || (key === "response" && isObject))
        ) {
          collect(value as Record<string, unknown>);
          continue;
        }
        const serialized = JSON.stringify(value);
        const bytes =
          Buffer.byteLength(serialized) -
          Buffer.byteLength(TRUNCATED_TRACE_JSON);
        const encodedBytes =
          Buffer.byteLength(JSON.stringify(serialized)) -
          Buffer.byteLength(JSON.stringify(TRUNCATED_TRACE_JSON));
        if (bytes > 0 && encodedBytes > 0) {
          candidates.push({
            bytes,
            encodedBytes,
            replace: () => {
              (container as Record<string, unknown>)[key] = truncated;
            },
          });
        }
      }
    }
    collect(payload as Record<string, unknown>);
    candidates.sort((a, b) => b.bytes - a.bytes);
    for (const candidate of candidates) {
      if (traceJsonFits(bytes, encodedBytes)) break;
      candidate.replace();
      bytes -= candidate.bytes;
      encodedBytes -= candidate.encodedBytes;
    }
  }
  shrink(true);
  if (mode === "full" && !traceJsonFits(bytes, encodedBytes)) shrink(false);
  return traceJsonFits(bytes, encodedBytes) ? marked() : TRUNCATED_TRACE_JSON;
}
