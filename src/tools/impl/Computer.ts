import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CDP_PORT = Number(process.env.LETTA_COMPUTER_CDP_PORT || 9224);
const DEFAULT_WIDTH = Number(process.env.LETTA_COMPUTER_WIDTH || 1280);
const DEFAULT_HEIGHT = Number(process.env.LETTA_COMPUTER_HEIGHT || 800);

type Action = Record<string, unknown>;

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type ComputerState = {
  process?: ChildProcessWithoutNullStreams;
  ws?: WebSocket;
  nextId: number;
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
};

const state: ComputerState = { nextId: 1, pending: new Map() };

function nativeComputerUseEnabled(): boolean {
  return (
    process.env.LETTA_ENABLE_COMPUTER_USE === "1" ||
    process.env.LETTA_ENABLE_COMPUTER_USE === "true"
  );
}

function chromeExecutable(): string {
  const candidates = [
    process.env.LETTA_COMPUTER_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  return candidates[0] ?? "google-chrome";
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} from ${url}`);
  return (await response.json()) as Record<string, unknown>;
}

async function waitForCdp(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(
    `Timed out waiting for Chrome CDP on port ${CDP_PORT}: ${String(lastError)}`,
  );
}

async function createTarget(): Promise<string> {
  try {
    const target = await fetchJson(
      `http://127.0.0.1:${CDP_PORT}/json/new?about:blank`,
      { method: "PUT" },
    );
    const wsUrl = target.webSocketDebuggerUrl;
    if (typeof wsUrl === "string") return wsUrl;
  } catch {
    const target = await fetchJson(
      `http://127.0.0.1:${CDP_PORT}/json/new?about:blank`,
    );
    const wsUrl = target.webSocketDebuggerUrl;
    if (typeof wsUrl === "string") return wsUrl;
  }
  throw new Error("Chrome did not return a page WebSocket URL");
}

async function ensureSession(): Promise<WebSocket> {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return state.ws;

  const profileDir = path.join(
    os.tmpdir(),
    "letta-code-computer-use-chrome-profile",
  );
  await fs.mkdir(profileDir, { recursive: true });
  state.process ??= spawn(
    chromeExecutable(),
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "pipe" },
  );

  await waitForCdp();
  const wsUrl = await createTarget();
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as CdpResponse;
    if (!msg.id) return;
    const pending = state.pending.get(msg.id);
    if (!pending) return;
    state.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
    else pending.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    if (state.ws === ws) state.ws = undefined;
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("CDP WebSocket connection failed")),
      { once: true },
    );
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return ws;
}

async function send(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const ws = await ensureSession();
  const id = state.nextId++;
  const promise = new Promise<unknown>((resolve, reject) =>
    state.pending.set(id, { resolve, reject }),
  );
  ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  return promise;
}

function numberArg(action: Action, names: string[], fallback = 0): number {
  for (const name of names) {
    const value = action[name];
    if (typeof value === "number") return value;
  }
  return fallback;
}

async function keyPress(key: string): Promise<void> {
  const parts = key
    .split(/[+-]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const main = parts.pop() ?? key;
  const modifiers = parts.reduce((mask, part) => {
    const upper = part.toUpperCase();
    if (upper === "ALT" || upper === "OPTION") return mask | 1;
    if (upper === "CTRL" || upper === "CONTROL") return mask | 2;
    if (upper === "META" || upper === "CMD" || upper === "COMMAND")
      return mask | 4;
    if (upper === "SHIFT") return mask | 8;
    return mask;
  }, 0);
  const upperMain = main.toUpperCase();
  const keyMap: Record<string, { key: string; code: string; text?: string }> = {
    ENTER: { key: "Enter", code: "Enter" },
    RETURN: { key: "Enter", code: "Enter" },
    TAB: { key: "Tab", code: "Tab" },
    ESC: { key: "Escape", code: "Escape" },
    ESCAPE: { key: "Escape", code: "Escape" },
    BACKSPACE: { key: "Backspace", code: "Backspace" },
    DELETE: { key: "Delete", code: "Delete" },
    SPACE: { key: " ", code: "Space", text: " " },
    ARROWUP: { key: "ArrowUp", code: "ArrowUp" },
    UP: { key: "ArrowUp", code: "ArrowUp" },
    ARROWDOWN: { key: "ArrowDown", code: "ArrowDown" },
    DOWN: { key: "ArrowDown", code: "ArrowDown" },
    ARROWLEFT: { key: "ArrowLeft", code: "ArrowLeft" },
    LEFT: { key: "ArrowLeft", code: "ArrowLeft" },
    ARROWRIGHT: { key: "ArrowRight", code: "ArrowRight" },
    RIGHT: { key: "ArrowRight", code: "ArrowRight" },
  };
  const spec = keyMap[upperMain] ?? {
    key: main,
    code: `Key${upperMain}`,
    text: main.length === 1 && modifiers === 0 ? main : undefined,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...spec, modifiers });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...spec,
    text: undefined,
    modifiers,
  });
}

async function executeAction(action: Action): Promise<void> {
  const kind = String(action.type ?? action.action ?? "screenshot");
  const x = numberArg(action, ["x", "coordinate_x"]);
  const y = numberArg(action, ["y", "coordinate_y"]);
  switch (kind) {
    case "screenshot":
      return;
    case "mouse_move":
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return;
    case "click":
    case "left_click":
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return;
    case "double_click":
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 2,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 2,
      });
      return;
    case "right_click":
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "right",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "right",
        clickCount: 1,
      });
      return;
    case "type":
      await send("Input.insertText", { text: String(action.text ?? "") });
      return;
    case "key":
    case "keypress": {
      const keys = Array.isArray(action.keys)
        ? action.keys
        : [action.key ?? action.text];
      for (const key of keys) if (typeof key === "string") await keyPress(key);
      return;
    }
    case "scroll": {
      const deltaX = numberArg(action, ["scroll_x", "delta_x", "dx"], 0);
      const deltaY = numberArg(action, ["scroll_y", "delta_y", "dy"], 0);
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      return;
    }
    case "wait":
      await new Promise((resolve) =>
        setTimeout(resolve, numberArg(action, ["ms", "duration"], 1000)),
      );
      return;
    default:
      throw new Error(`Unsupported computer action: ${kind}`);
  }
}

function normalizeActions(args: Record<string, unknown>): Action[] {
  if (Array.isArray(args.actions))
    return args.actions.filter(
      (value): value is Action => typeof value === "object" && value !== null,
    ) as Action[];
  return [args];
}

export async function computer(args: Record<string, unknown>) {
  if (!nativeComputerUseEnabled()) {
    throw new Error(
      "Native computer use is disabled. Set LETTA_ENABLE_COMPUTER_USE=1 to enable it.",
    );
  }
  await ensureSession();
  for (const action of normalizeActions(args)) await executeAction(action);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = (await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  })) as { data?: string };
  if (!result.data) throw new Error("Chrome did not return a screenshot");
  const metadata: Record<string, unknown> = { detail: "original" };
  if (Array.isArray(args.pending_safety_checks)) {
    metadata.acknowledged_safety_checks = args.pending_safety_checks;
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: result.data },
      },
    ],
  };
}
