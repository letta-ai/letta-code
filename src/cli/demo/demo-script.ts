import { readFile } from "node:fs/promises";

export type DemoScriptMessage = {
  text: string;
  delayMs?: number;
  typingMs?: number;
  submit?: boolean;
  waitForIdle?: boolean;
};

export type DemoScript = {
  startDelayMs?: number;
  loop?: boolean;
  messages: DemoScriptMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Demo script field ${fieldName} must be a non-negative number`,
    );
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Demo script field ${fieldName} must be a boolean`);
  }
  return value;
}

function parseMessage(value: unknown, index: number): DemoScriptMessage {
  if (!isRecord(value)) {
    throw new Error(`Demo script message ${index} must be an object`);
  }
  if (typeof value.text !== "string") {
    throw new Error(`Demo script message ${index}.text must be a string`);
  }

  return {
    text: value.text,
    delayMs: readOptionalNumber(value.delayMs, `messages[${index}].delayMs`),
    typingMs: readOptionalNumber(value.typingMs, `messages[${index}].typingMs`),
    submit: readOptionalBoolean(value.submit, `messages[${index}].submit`),
    waitForIdle: readOptionalBoolean(
      value.waitForIdle,
      `messages[${index}].waitForIdle`,
    ),
  };
}

export function parseDemoScriptJson(value: unknown): DemoScript {
  const root = Array.isArray(value) ? { messages: value } : value;
  if (!isRecord(root)) {
    throw new Error("Demo script must be an array or an object");
  }

  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error("Demo script must include at least one message");
  }

  return {
    startDelayMs: readOptionalNumber(root.startDelayMs, "startDelayMs"),
    loop: readOptionalBoolean(root.loop, "loop"),
    messages: rawMessages.map(parseMessage),
  };
}

export async function loadDemoScript(path: string): Promise<DemoScript> {
  const contents = await readFile(path, "utf8");
  try {
    return parseDemoScriptJson(JSON.parse(contents));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid demo script ${path}: ${message}`);
  }
}
