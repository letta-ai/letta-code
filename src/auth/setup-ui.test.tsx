import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { __testSetBackend, configureBackendMode, getBackend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { settingsManager } from "@/settings-manager";
import { type SetupResult, SetupUI } from "./setup-ui";

// Use real Ink streams, as in the component tests; ink-testing-library is not
// installed. No auth/provider modules are mocked, and we never start OAuth.
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

  output() {
    return stripAnsi(this.chunks.join(""));
  }
}

const environmentKeys = [
  "HOME",
  "USERPROFILE",
  "LETTA_LOCAL_BACKEND_DIR",
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_BASE_URL",
  "LETTA_API_KEY",
  "LETTA_SKIP_KEYCHAIN_CHECK",
] as const;
let originalEnv: Record<string, string | undefined>;
let originalMode: ReturnType<typeof resolveBackendMode>;
let originalBackend: ReturnType<typeof getBackend>;
let home: string;
let instance: ReturnType<typeof render> | undefined;

beforeEach(async () => {
  await settingsManager.reset();
  originalEnv = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  originalMode = resolveBackendMode();
  originalBackend = getBackend();
  home = await mkdtemp(join(tmpdir(), "letta-setup-ui-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LETTA_LOCAL_BACKEND_DIR = join(home, "backend");
  process.env.LETTA_BASE_URL = "https://api.letta.com";
  process.env.LETTA_API_KEY = "";
  process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
  configureBackendMode("api");
  await settingsManager.initialize();
  await settingsManager.flush();
});

afterEach(async () => {
  instance?.unmount();
  instance?.cleanup();
  instance = undefined;
  await settingsManager.reset();
  setConfiguredBackendMode(originalMode);
  __testSetBackend(originalBackend);
  for (const key of environmentKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(predicate()).toBe(true);
}

function mount(localModeDisabledReason?: string) {
  const stdout = new CaptureStream();
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const completed: SetupResult[] = [];
  let cancelled = false;
  instance = render(
    <SetupUI
      onComplete={(result) => completed.push(result)}
      onCancel={() => {
        cancelled = true;
      }}
      localModeDisabledReason={localModeDisabledReason}
    />,
    {
      stdout: stdout as CaptureStream & NodeJS.WriteStream,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return {
    stdout,
    stdin,
    completed,
    cancelled: () => cancelled,
  };
}

async function settingsFile() {
  return readFile(join(home, ".letta", "settings.json"), "utf8");
}

test("setup highlights Sign in with Letta by default and exiting writes no preference", async () => {
  const before = await settingsFile();
  const ui = mount();
  await waitFor(() => ui.stdout.output().includes("> Sign in with Letta"));
  expect(ui.stdout.output()).toContain("Proceed locally");
  expect(ui.stdout.output()).not.toContain("> Proceed locally");
  expect(ui.stdout.output()).not.toContain("Proceed locally (default)");

  ui.stdin.push("\u001b[B");
  await waitFor(() => ui.stdout.output().includes("> Proceed locally"));
  ui.stdin.push("\u001b[B");
  await waitFor(() => ui.stdout.output().includes("> Exit"));
  ui.stdin.push("\r");
  await waitFor(ui.cancelled);
  expect(ui.completed).toEqual([]);
  await settingsManager.flush();
  expect(await settingsFile()).toBe(before);
  expect(settingsManager.getSettings().preferredBackendMode).toBeUndefined();
});

test("choosing Proceed locally saves the real preference before completing", async () => {
  const ui = mount();
  await waitFor(() => ui.stdout.output().includes("> Sign in with Letta"));
  ui.stdin.push("\u001b[B");
  await waitFor(() => ui.stdout.output().includes("> Proceed locally"));
  ui.stdin.push("\r");
  await waitFor(() => ui.completed.length === 1);
  expect(ui.completed).toEqual([{ kind: "local" }]);
  expect(ui.cancelled()).toBe(false);
  expect(resolveBackendMode()).toBe("local");
  expect(JSON.parse(await settingsFile()).preferredBackendMode).toBe("local");

  await settingsManager.reset();
  await settingsManager.initialize();
  expect(settingsManager.getSettings().preferredBackendMode).toBe("local");
});

test("an explicit Cloud restriction skips Local in both keyboard directions", async () => {
  const before = await settingsFile();
  const reason = "--backend cloud requires signing in with Letta.";
  const ui = mount(reason);
  await waitFor(() => ui.stdout.output().includes("> Sign in with Letta"));
  expect(ui.stdout.output()).toContain("Proceed locally (unavailable)");
  expect(ui.stdout.output()).toContain(reason);
  ui.stdin.push("\u001b[B");
  await waitFor(() => ui.stdout.output().includes("> Exit"));
  ui.stdout.chunks = [];
  ui.stdin.push("\u001b[A");
  await waitFor(() => ui.stdout.output().includes("> Sign in with Letta"));
  expect(ui.stdout.output()).not.toContain("> Proceed locally");
  ui.stdout.chunks = [];
  ui.stdin.push("\u001b[B");
  await waitFor(() => ui.stdout.output().includes("> Exit"));
  ui.stdin.push("\r");
  await waitFor(ui.cancelled);
  expect(ui.completed).toEqual([]);
  expect(resolveBackendMode()).toBe("api");
  await settingsManager.flush();
  expect(await settingsFile()).toBe(before);
});
