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

/** Headers are never captured. Also redact credential fields and known values in bodies. */
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

/** Preserve every SSE JSON event as well as the assembled provider response. */
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
