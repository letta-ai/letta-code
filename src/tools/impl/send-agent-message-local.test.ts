import { afterEach, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearAllSubagents, getSubagents } from "@/agent/subagent-state";
import { LocalBackend } from "@/backend/local/local-backend";
import { LocalStore } from "@/backend/local/local-store";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  caller,
  message,
  sendAgentMessageFixture,
} from "@/test-utils/send-agent-message-fixture";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";
import { send_agent_message } from "./send-agent-message";

afterEach(() => clearAllSubagents());

async function send(
  tags: readonly string[] = ["parent:agent-caller", "type:explore"],
  explicitAgent = false,
) {
  const f = sendAgentMessageFixture(tags);
  f.backend.capabilities.environmentRouting = false;
  const process = new ChildProcess();
  let launches = 0;
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      { ...message, ...(explicitAgent ? { agent_id: "agent-target" } : {}) },
      {
        ...f,
        spawnLocal: () => {
          launches++;
          return process;
        },
      },
    ),
  );
  return { process, result, launches, f };
}

test.each([false, true])(
  "local own-child send registers in the caller conversation (explicit agent: %s)",
  async (explicit) => {
    const { process, result, launches, f } = await send(undefined, explicit);
    expect(result.status).toBe("success");
    expect(launches).toBe(1);
    expect(f.submissions).toHaveLength(0);
    expect(getSubagents()).toHaveLength(1);
    expect(getSubagents()[0]).toMatchObject({
      status: "running",
      agentId: "agent-target",
      conversationId: message.conversation_id,
      parentAgentId: caller.agentId,
      parentConversationId: caller.conversationId,
      prompt: message.message,
      isBackground: true,
      claimsParentRuntime: false,
    });
    process.emit("exit", 0, null);
    expect(getSubagents()[0]?.status).toBe("completed");
  },
);

test.each([{ tags: [] }, { tags: ["parent:agent-other"] }])(
  "local peers stay untracked: %j",
  async ({ tags }) => {
    const { process, launches, result } = await send(tags);
    expect(result.status).toBe("success");
    expect(launches).toBe(1);
    expect(getSubagents()).toHaveLength(0);
    process.emit("exit", 0, null);
    expect(getSubagents()).toHaveLength(0);
  },
);

test.each(["error", "exit", "signal"])(
  "local child settles once on process %s",
  async (kind) => {
    const { process, launches } = await send();
    expect(getSubagents()).toHaveLength(1);
    if (kind === "error") process.emit("error", new Error("spawn ENOENT"));
    else
      process.emit(
        "exit",
        kind === "exit" ? 1 : null,
        kind === "signal" ? "SIGTERM" : null,
      );
    expect(getSubagents()[0]?.status).toBe("error");
    expect(getSubagents()[0]?.error).toBeTruthy();
    process.emit("exit", 0, null);
    expect(getSubagents()[0]?.status).toBe("error");
    expect(launches).toBe(1);
  },
);

test("failed local metadata lookup still sends once without tracking", async () => {
  const f = sendAgentMessageFixture(["parent:agent-caller"]);
  f.backend.capabilities.environmentRouting = false;
  f.backend.retrieveConversation = async () => {
    throw new Error("missing metadata");
  };
  let launches = 0;
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(message, {
      ...f,
      spawnLocal: () => {
        launches++;
        return new ChildProcess();
      },
    }),
  );
  expect(result.status).toBe("success");
  expect(launches).toBe(1);
  expect(getSubagents()).toHaveLength(0);
});

test("a supplied child ID cannot make a peer conversation tracked", async () => {
  const f = sendAgentMessageFixture(["parent:agent-caller"]);
  f.backend.capabilities.environmentRouting = false;
  const retrieveAgent = f.backend.retrieveAgent;
  f.backend.retrieveAgent = async (id, options) => ({
    ...(await retrieveAgent(id, options)),
    tags: id === "agent-child" ? ["parent:agent-caller"] : [],
  });
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      { ...message, agent_id: "agent-child" },
      {
        ...f,
        spawnLocal: () => new ChildProcess(),
      },
    ),
  );
  expect(result.status).toBe("success");
  expect(getSubagents()).toHaveLength(0);
});

test("real detached local CLI delivers once and settles the parent's child entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-send-tracking-"));
  const storageDir = join(root, "store");
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const child = await backend.createAgent({
    name: "Child",
    tags: ["parent:agent-caller", "type:explore"],
  } as never);
  const conversation = await backend.createConversation({ agent_id: child.id });
  const cli = process.env.LETTA_TEST_CLI_BUNDLE;
  const overrides = createIsolatedCliTestEnv({
    LETTA_CONFIG_DIR: join(root, "config"),
    USER_CWD: root,
    LETTA_LOCAL_BACKEND_DIR: storageDir,
    LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
    LETTA_SKIP_KEYCHAIN_CHECK: "1",
    LETTA_DISABLE_MODS: "1",
    LETTA_CODE_BIN: cli ? "node" : process.execPath,
    // The child runs in the fixture directory, where Bun 1.3 does not
    // discover the repository config that loads Markdown prompts as text.
    LETTA_CODE_BIN_ARGS_JSON: JSON.stringify([
      ...(cli
        ? []
        : [
            "--loader=.md:text",
            "--loader=.mdx:text",
            "--loader=.txt:text",
            "run",
          ]),
      cli ?? resolve("src/index.ts"),
      "--tools=",
      "--no-skills",
      "--no-system-info-reminder",
    ]),
  });
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, overrides);
    const result = await runWithRuntimeContext(
      { ...caller, workingDirectory: root },
      () =>
        send_agent_message(
          {
            conversation_id: conversation.id,
            message: "Check local delivery once.",
          },
          { backend },
        ),
    );
    expect(result.status).toBe("success");
    expect(getSubagents()).toHaveLength(1);
    expect(getSubagents()[0]).toMatchObject({
      status: "running",
      parentConversationId: caller.conversationId,
      claimsParentRuntime: false,
    });
    const deadline = Date.now() + 20000;
    while (getSubagents()[0]?.status === "running" && Date.now() < deadline)
      await Bun.sleep(25);
    expect(getSubagents()[0]?.status, getSubagents()[0]?.error).toBe(
      "completed",
    );
    const store = new LocalStore(child.id, {
      storageDir,
      seedDefaultAgent: false,
    });
    const messages = store.listConversationMessages(conversation.id);
    expect(
      messages.filter((row) => row.message_type === "user_message"),
    ).toHaveLength(1);
    expect(
      messages.some((row) => row.message_type === "assistant_message"),
    ).toBe(true);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
