import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import Letta from "@letta-ai/letta-client";
import { type Instance, render } from "ink";
import { __testSetBackend, APIBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { App } from "@/cli/App";
import { settingsManager } from "@/settings-manager";

const AGENT_ID = "agent-busy-http";
const CONVERSATION_ID = "conv-busy-http";
const AGENT = {
  id: AGENT_ID,
  name: "Busy HTTP Agent",
  description: null,
  system: "",
  tools: [],
  tags: [],
  model: "openai/gpt-5-mini",
  model_settings: {},
  message_ids: [],
  in_context_message_ids: [],
  llm_config: {
    model: "gpt-5-mini",
    model_endpoint: "https://example.invalid/v1",
    context_window: 128000,
  },
} as never;

class TuiOutput extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.chunks.push(chunk.toString());
    done();
  }
}

function createInput(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(20);
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  await sleep(200);
  stdin.push(text);
  await sleep(50);
  stdin.push("\r");
}

function conflict(detail: string): Response {
  return Response.json({ error: { detail } }, { status: 409 });
}

function acceptedStream(): Response {
  return new Response(
    'data: {"message_type":"stop_reason","stop_reason":"end_turn","run_id":"run-original"}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
}

const servers = new Set<ReturnType<typeof Bun.serve>>();
const instances = new Set<Instance>();
let previousBackendMode: BackendMode;
let previousHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("api");
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-busy-http-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const instance of instances) {
    instance.unmount();
    instance.cleanup();
  }
  instances.clear();
  for (const server of servers) server.stop(true);
  servers.clear();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function installHttpBackend(
  fetchHandler: (request: Request) => Response | Promise<Response>,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });
  servers.add(server);
  const client = new Letta({
    apiKey: "test-key",
    baseURL: server.url.href,
    maxRetries: 0,
  });
  __testSetBackend(new APIBackend({ getClient: async () => client }));
}

async function renderApp() {
  const stdin = createInput();
  const stdout = new TuiOutput() as TuiOutput & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={AGENT_ID}
      agentState={AGENT}
      conversationId={CONVERSATION_ID}
      modsDisabled
      systemInfoReminderEnabled={false}
    />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  instances.add(instance);
  return { stdin, stdout };
}

function commonGet(request: Request): Response | null {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === `/v1/agents/${AGENT_ID}`) {
    return Response.json(AGENT);
  }
  if (request.method === "GET" && url.pathname.includes("/models")) {
    return Response.json([]);
  }
  if (request.method === "GET") return Response.json([]);
  return null;
}

describe("TUI busy prompt recovery over the Core HTTP contract", () => {
  test("preserves the original across approval and continuation blockers without denying tools", async () => {
    const postBodies: unknown[] = [];
    const requests: string[] = [];
    let sendAttempt = 0;
    installHttpBackend(async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const common = commonGet(request);
      if (common && !url.pathname.startsWith("/v1/runs/")) return common;
      if (
        request.method === "GET" &&
        url.pathname === "/v1/runs/run-approval"
      ) {
        return Response.json({
          id: "run-approval",
          agent_id: AGENT_ID,
          conversation_id: CONVERSATION_ID,
          status: "completed",
          stop_reason: "requires_approval",
          metadata: {},
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/runs/run-continuation"
      ) {
        return Response.json({
          id: "run-continuation",
          agent_id: AGENT_ID,
          conversation_id: CONVERSATION_ID,
          status: "completed",
          stop_reason: "end_turn",
          metadata: {},
        });
      }
      if (request.method === "POST" && url.pathname.includes("/messages")) {
        postBodies.push(await request.json());
        sendAttempt += 1;
        if (sendAttempt === 1) {
          return conflict(
            "Another request is currently being processed for this conversation. run_id=run-approval",
          );
        }
        if (sendAttempt === 2)
          return conflict("Conversation is waiting for approval");
        if (sendAttempt === 3) {
          return conflict(
            "Another request is currently being processed for this conversation. run_id=run-continuation",
          );
        }
        return acceptedStream();
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });

    const { stdin, stdout } = await renderApp();
    await typePrompt(stdin, "preserve this exact prompt");
    await waitFor(
      () => postBodies.length === 4,
      "the original prompt to be accepted",
    );

    expect(postBodies.slice(1)).toEqual([
      postBodies[0],
      postBodies[0],
      postBodies[0],
    ]);
    expect(JSON.stringify(postBodies)).not.toContain("approval");
    expect(requests.some((request) => request.includes("approvals"))).toBe(
      false,
    );
    expect(stdout.chunks.join("")).toContain(
      "waiting for the blocking turn's approval",
    );
  }, 30_000);

  test("Esc cancels the pending original while its named blocker is active", async () => {
    const postBodies: unknown[] = [];
    let runPolls = 0;
    installHttpBackend(async (request) => {
      const url = new URL(request.url);
      const common = commonGet(request);
      if (common && !url.pathname.startsWith("/v1/runs/")) return common;
      if (request.method === "GET" && url.pathname === "/v1/runs/run-active") {
        runPolls += 1;
        return Response.json({
          id: "run-active",
          agent_id: AGENT_ID,
          conversation_id: CONVERSATION_ID,
          status: "running",
          metadata: {},
        });
      }
      if (request.method === "POST" && url.pathname.includes("/messages")) {
        postBodies.push(await request.json());
        return conflict(
          "Another request is currently being processed for this conversation. run_id=run-active",
        );
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });

    const { stdin } = await renderApp();
    await typePrompt(stdin, "cancel this pending prompt");
    await waitFor(() => runPolls > 0, "the blocking-run poll to start");
    stdin.push("\u001b");
    await sleep(300);

    expect(postBodies).toHaveLength(1);
    expect(runPolls).toBeGreaterThan(0);
  }, 10_000);
});
