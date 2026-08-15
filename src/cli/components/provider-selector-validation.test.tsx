import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { type Instance, render } from "ink";
import stripAnsi from "strip-ansi";
import { configureBackendMode } from "@/backend";
import { type BackendMode, resolveBackendMode } from "@/backend/backend-mode";
import { settingsManager } from "@/settings-manager";
import { ProviderSelector } from "./ProviderSelector";

class CaptureStream extends Writable {
  columns = 100;
  rows = 30;
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

  read(): string {
    return this.chunks.join("");
  }

  reset(): void {
    this.chunks = [];
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

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${message}`);
}

async function typeInput(
  stdin: NodeJS.ReadStream,
  value: string,
): Promise<void> {
  for (const character of value) {
    stdin.push(character);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let previousBackendMode: BackendMode;
let previousBaseUrl: string | undefined;
let previousApiKey: string | undefined;
let instance: Instance | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  previousBaseUrl = process.env.LETTA_BASE_URL;
  previousApiKey = process.env.LETTA_API_KEY;
  configureBackendMode("api");
  await settingsManager.initialize();
});

afterEach(() => {
  instance?.unmount();
  instance?.cleanup();
  instance = undefined;
  server?.stop(true);
  server = undefined;
  configureBackendMode(previousBackendMode);
  if (previousBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = previousBaseUrl;
  if (previousApiKey === undefined) delete process.env.LETTA_API_KEY;
  else process.env.LETTA_API_KEY = previousApiKey;
});

describe("ProviderSelector validation", () => {
  test("validates an OpenAI-compatible key against the entered base URL", async () => {
    let checkBody: Record<string, unknown> | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/providers") {
          return Response.json([]);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/v1/providers/check"
        ) {
          checkBody = (await request.json()) as Record<string, unknown>;
          return Response.json({ message: "Valid API key" });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    process.env.LETTA_BASE_URL = server.url.origin;
    process.env.LETTA_API_KEY = "letta-test-key";

    const stdin = createInputStream();
    const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
    instance = render(<ProviderSelector onCancel={() => {}} />, {
      stdin,
      stdout,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    await waitFor(
      () => stripAnsi(stdout.read()).includes("[ Local ]    Cloud"),
      "provider store tabs",
    );
    stdout.reset();
    stdin.push("\t");
    await waitFor(() => {
      const output = stripAnsi(stdout.read());
      return (
        output.includes("[ Cloud ]") && output.includes("OpenAI-compatible API")
      );
    }, "Cloud provider list");
    stdout.reset();
    for (let index = 0; index < 3; index += 1) {
      stdin.push("\u001b[B");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await waitFor(
      () => stripAnsi(stdout.read()).includes("> [ ] OpenAI-compatible API"),
      "OpenAI-compatible selection",
    );
    stdout.reset();
    stdin.push("\r");
    await waitFor(
      () => stdout.read().includes("Connect OpenAI-compatible API"),
      "provider fields",
    );
    stdout.reset();
    await typeInput(stdin, "third-party-key");
    await waitFor(
      () => stripAnsi(stdout.read()).includes("thir***********"),
      "API key input",
    );
    stdout.reset();
    stdin.push("\t");
    await waitFor(
      () => stripAnsi(stdout.read()).includes("> Base URL"),
      "base URL field",
    );
    stdout.reset();
    for (const _character of "https://proxy.example.com/v1") {
      stdin.push("\u007f");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await typeInput(stdin, "https://opencode.ai/zen/go/v1");
    await waitFor(
      () => stdout.read().includes("https://opencode.ai/zen/go/v1"),
      "base URL input",
    );
    stdin.push("\r");

    await waitFor(() => checkBody !== undefined, "provider validation request");
    expect(checkBody).toEqual({
      provider_type: "openai",
      api_key: "third-party-key",
      base_url: "https://opencode.ai/zen/go/v1",
    });
  });
});
