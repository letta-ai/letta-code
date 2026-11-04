// Native pi CLI tests against a local fake provider. Run by the pi
// integration CI job; requires `pi` on PATH but no API key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import {
  type FakeOpenAiChatServer,
  fakePiModelsJson,
  startFakeOpenAiChatServer,
} from "@/test-utils/fake-openai-chat-server";
import { runExternalCodingAgent } from "./external-coding-agent";
import type {
  ExternalToolCall,
  ExternalToolResult,
} from "./external-tool-call";
import { closePiSessions, listPiModels, sendPiMessage } from "./pi-rpc-session";
import { findPiSessionPath } from "./pi-session-paths";

let root: string;
let cwd: string;
let provider: FakeOpenAiChatServer;
const oldEnv = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "letta-pi-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  provider = await startFakeOpenAiChatServer({ slowMs: 1_500 });
  const agentDir = join(root, "pi-agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "models.json"),
    fakePiModelsJson(provider.baseUrl),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.LETTA_CONFIG_DIR = join(root, "letta");
  await settingsManager.initialize();
});

afterAll(async () => {
  await closePiSessions();
  await provider?.close();
  process.env = oldEnv;
  await rm(root, { recursive: true, force: true });
});

test("lists the configured pi models", async () => {
  const models = await listPiModels(cwd, process.env);
  expect(models).toContainEqual({ id: "fake/fake-1", displayName: "Fake One" });
});

test("runs a tool-using turn, then resumes the session in a new process", async () => {
  const calls: ExternalToolCall[] = [];
  const results: ExternalToolResult[] = [];
  const first = await runExternalCodingAgent({
    type: "pi",
    prompt: "RUN_TOOL please",
    model: "fake/fake-1",
    parentAgentId: "agent-pi-test",
    cwd,
    onToolCall: (call) => calls.push(call),
    onToolResult: (result) => results.push(result),
  });
  expect(first.success, first.error).toBe(true);
  expect(first.report).toBe("Tool said: tool-ran");
  expect(first.model).toBe("fake/fake-1");
  expect(calls).toMatchObject([
    { name: "bash", input: { command: "echo tool-ran" } },
  ]);
  expect(results).toMatchObject([
    { name: "bash", isError: false, output: "tool-ran\n" },
  ]);
  const sessionId = first.runtimeSessionId as string;
  expect(await findPiSessionPath(sessionId)).toEndWith(`_${sessionId}.jsonl`);

  await closePiSessions();
  const receipt = await sendPiMessage(
    { sessionId, prompt: "and now?", parentAgentId: "agent-pi-test", cwd },
    process.env,
  );
  expect(receipt.mode).toBe("new_turn");
  const resumed = await receipt.completion;
  expect(resumed?.success, resumed?.error).toBe(true);
  // The provider sees both user turns, so pi reloaded the history.
  expect(resumed?.report).toBe("Turns so far: 2");
  expect(resumed?.runtimeSessionId).toBe(sessionId);
}, 60_000);

test("steers an active turn", async () => {
  let sessionId = "";
  const running = runExternalCodingAgent({
    type: "pi",
    prompt: "SLOW start",
    model: "fake/fake-1",
    parentAgentId: "agent-pi-test",
    cwd,
    onStarted: (agentId) => {
      sessionId = agentId.replace(/^pi_/, "");
    },
  });
  for (let i = 0; i < 400 && !sessionId; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const steer = await sendPiMessage(
    {
      sessionId,
      prompt: "STEER go left",
      parentAgentId: "agent-pi-test",
      cwd,
    },
    process.env,
  );
  expect(steer.mode).toBe("steered");
  const result = await running;
  expect(result.success, result.error).toBe(true);
  expect(result.report).toBe("Steered: STEER go left");
}, 60_000);

test("aborting stops the turn without hanging", async () => {
  const controller = new AbortController();
  const result = await runExternalCodingAgent({
    type: "pi",
    prompt: "SLOW then abort",
    model: "fake/fake-1",
    parentAgentId: "agent-pi-test",
    cwd,
    signal: controller.signal,
    onStarted: () => setTimeout(() => controller.abort(), 200),
  });
  expect(result.success).toBe(false);
}, 60_000);
