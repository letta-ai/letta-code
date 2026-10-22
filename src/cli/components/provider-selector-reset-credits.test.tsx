import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { type Instance, render } from "ink";
import stripAnsi from "strip-ansi";
import { configureBackendMode } from "@/backend";
import { type BackendMode, resolveBackendMode } from "@/backend/backend-mode";
import { setLocalOAuthProvider } from "@/backend/local/local-provider-auth-store";
import { useChatGPTRateLimitState } from "@/cli/hooks/use-chatgpt-rate-limit-state";
import { settingsManager } from "@/settings-manager";
import { ProviderSelector } from "./ProviderSelector";

class CaptureStream extends Writable {
  columns = 100;
  rows = 40;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }

  latest(): string {
    return stripAnsi(this.chunks.at(-1) ?? "");
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function waitForScreen(
  stdout: CaptureStream,
  predicate: (screen: string) => boolean,
  label: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const screen = stdout.latest();
    if (predicate(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}\n${stdout.latest()}`);
}

async function press(stdin: NodeJS.ReadStream, key: string, times = 1) {
  for (let index = 0; index < times; index += 1) {
    stdin.push(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const DOWN = "\u001b[B";
const ENTER = "\r";
// Usage and inventory are cached in module memory by provider name for 30s,
// so each test gets its own account name to start from a cold cache.
let testIndex = 0;
let PROVIDER_NAME = "";

/** Fake ChatGPT backend: one banked reset that lifts a reached weekly limit. */
function fakeChatGPT() {
  const state = { limited: true, credits: 2, consumeBodies: [] as unknown[] };
  const handler = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/wham/usage")) {
      return Response.json({
        plan_type: "pro",
        rate_limit: {
          limit_reached: state.limited,
          primary_window: {
            used_percent: state.limited ? 100 : 0,
            limit_window_seconds: 604_800,
            reset_after_seconds: 400_000,
          },
        },
      });
    }
    if (url.endsWith("/rate-limit-reset-credits/consume")) {
      state.consumeBodies.push(JSON.parse(String(init?.body)));
      state.limited = false;
      state.credits -= 1;
      return Response.json({ outcome: "reset" });
    }
    if (url.endsWith("/rate-limit-reset-credits")) {
      return Response.json({
        available_count: state.credits,
        credits: Array.from({ length: state.credits }, (_, index) => ({
          id: `RateLimitResetCredit_${index + 1}`,
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-10-01T00:00:00Z",
          expires_at: new Date(
            Date.now() + (index + 2) * 86_400_000,
          ).toISOString(),
          title: "Full reset",
        })),
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { state, handler };
}

let previousBackendMode: BackendMode;
let previousLocalDir: string | undefined;
let previousFetch: typeof fetch;
let storageDir = "";
let instance: Instance | undefined;
let settingsSpy:
  | ReturnType<
      typeof spyOn<typeof settingsManager, "getSettingsWithSecureTokens">
    >
  | undefined;

beforeEach(async () => {
  testIndex += 1;
  PROVIDER_NAME = `chatgpt-reset-test-${testIndex}`;
  previousBackendMode = resolveBackendMode();
  previousLocalDir = process.env.LETTA_LOCAL_BACKEND_DIR;
  previousFetch = globalThis.fetch;
  storageDir = await mkdtemp(join(tmpdir(), "letta-tui-reset-credits-"));
  process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
  configureBackendMode("local");
  await settingsManager.initialize();
  // The Local tab label is only shown when Cloud credentials are present.
  // Keep that UI state independent of the host and other tests' credentials.
  settingsSpy = spyOn(
    settingsManager,
    "getSettingsWithSecureTokens",
  ).mockResolvedValue({
    ...settingsManager.getSettings(),
    env: { LETTA_API_KEY: "letta-test-key" },
  });
  setLocalOAuthProvider({
    storageDir,
    providerName: PROVIDER_NAME,
    providerType: "chatgpt_oauth",
    auth: {
      type: "oauth",
      access: "chatgpt-access-token",
      refresh: "chatgpt-refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "chatgpt-account-1",
    },
  });
});

afterEach(async () => {
  instance?.unmount();
  instance?.cleanup();
  instance = undefined;
  settingsSpy?.mockRestore();
  settingsSpy = undefined;
  globalThis.fetch = previousFetch;
  configureBackendMode(previousBackendMode);
  if (previousLocalDir === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousLocalDir;
  await rm(storageDir, { recursive: true, force: true });
});

async function openResetConfirmation(
  stdin: NodeJS.ReadStream,
  stdout: CaptureStream,
): Promise<string> {
  await waitForScreen(
    stdout,
    (screen) => screen.includes("Filter:") && screen.includes("[ Local ]"),
    "provider list",
  );
  // Search narrows the list so selection does not depend on catalog order.
  for (const character of "chatgpt") await press(stdin, character);
  await waitForScreen(
    stdout,
    (screen) => /> \[✓\].*ChatGPT/.test(screen),
    "connected ChatGPT row selected",
  );
  await press(stdin, ENTER);
  const manage = await waitForScreen(
    stdout,
    (screen) =>
      screen.includes("Resets: 2 available") &&
      screen.includes(`Use a reset on ${PROVIDER_NAME}`),
    "usage, reset inventory, and reset action",
  );
  const actionLines = manage
    .split("\n")
    .filter((line) =>
      /^\s*(>|\s)\s(Disconnect|Connect|Reconnect|Use a reset|Refresh usage|Back)/.test(
        line,
      ),
    );
  await press(
    stdin,
    DOWN,
    actionLines.findIndex((line) => line.includes("Use a reset")),
  );
  await press(stdin, ENTER);
  await waitForScreen(
    stdout,
    (screen) => screen.includes(`Resets for ${PROVIDER_NAME}`),
    "reset picker",
  );
  await press(stdin, ENTER);
  await waitForScreen(
    stdout,
    (screen) => screen.includes(`Use a reset on ${PROVIDER_NAME}?`),
    "confirmation",
  );
  return manage;
}

function renderSelector() {
  const stdin = createInputStream();
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  instance = render(<ProviderSelector onCancel={() => {}} />, {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdin, stdout };
}

describe("ProviderSelector ChatGPT reset credits", () => {
  test("lists resets and spends one only after an explicit confirmation", async () => {
    const chatgpt = fakeChatGPT();
    globalThis.fetch = chatgpt.handler as typeof fetch;
    const { stdin, stdout } = renderSelector();

    const manage = await openResetConfirmation(stdin, stdout);
    expect(manage).toContain("0% left");
    // Choosing a credit alone never spends it.
    expect(chatgpt.state.consumeBodies).toHaveLength(0);

    await press(stdin, ENTER);
    const after = await waitForScreen(
      stdout,
      (screen) => screen.includes("Reset applied"),
      "reset outcome",
    );

    expect(chatgpt.state.consumeBodies).toHaveLength(1);
    expect(chatgpt.state.consumeBodies[0]).toMatchObject({
      credit_id: "RateLimitResetCredit_1",
    });
    expect(after).toContain("Resend your message to continue.");
    expect(after).toContain("Resets: 1 available");
    expect(after).toContain("100% left");
  }, 20_000);

  test("two confirms dispatched before any re-render spend one credit", async () => {
    const chatgpt = fakeChatGPT();
    globalThis.fetch = chatgpt.handler as typeof fetch;
    let api: ReturnType<typeof useChatGPTRateLimitState> | undefined;
    function Probe() {
      api = useChatGPTRateLimitState("local");
      return null;
    }
    instance = render(<Probe />, {
      stdin: createInputStream(),
      stdout: new CaptureStream() as CaptureStream & NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    if (!api) throw new Error("hook did not render");

    // Same render, same closure: React state could not have changed between
    // these calls, which is the window Amelia's review describes.
    const [first, second] = await Promise.all([
      api.consume(PROVIDER_NAME, "RateLimitResetCredit_1"),
      api.consume(PROVIDER_NAME, "RateLimitResetCredit_1"),
    ]);

    expect(chatgpt.state.consumeBodies).toHaveLength(1);
    expect(first?.notice.tone).toBe("success");
    expect(second).toBeNull();
  }, 20_000);

  test("a repeated confirm spends one credit and cannot disconnect the account", async () => {
    const chatgpt = fakeChatGPT();
    globalThis.fetch = chatgpt.handler as typeof fetch;
    const { stdin, stdout } = renderSelector();

    await openResetConfirmation(stdin, stdout);
    // Key repeat or a double-tap: the second Enter arrives while the first
    // spend is in flight, then again once the manage menu is back.
    stdin.push(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.push(ENTER);
    const after = await waitForScreen(
      stdout,
      (screen) => screen.includes("Reset applied"),
      "reset outcome",
    );
    await press(stdin, ENTER);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(chatgpt.state.consumeBodies).toHaveLength(1);
    expect(after).toMatch(/> Refresh usage/);
    expect(stdout.latest()).toContain(`${PROVIDER_NAME} · Connected`);
  }, 20_000);
});
