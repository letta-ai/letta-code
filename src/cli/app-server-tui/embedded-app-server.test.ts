import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { DeterministicScriptedExecutor } from "@/test-utils/scripted-turn-executor";
import {
  type EmbeddedAppServer,
  startEmbeddedAppServer,
} from "./embedded-app-server";
import {
  createTuiSessionStore,
  type TuiSessionStore,
  type TuiSnapshot,
} from "./session-store";

type SocketConstructor = NonNullable<
  ConstructorParameters<typeof LettaAgentClient>[0]["WebSocket"]
>;

const ORIGINAL_DISABLE_MODS = process.env.LETTA_DISABLE_MODS;
const ORIGINAL_DISABLE_CRON = process.env.LETTA_DISABLE_CRON_SCHEDULER;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
});

afterEach(() => {
  __testSetBackend(null);
  restoreEnv("LETTA_DISABLE_MODS", ORIGINAL_DISABLE_MODS);
  restoreEnv("LETTA_DISABLE_CRON_SCHEDULER", ORIGINAL_DISABLE_CRON);
});

function waitFor(
  store: TuiSessionStore,
  predicate: (snapshot: TuiSnapshot) => boolean,
  label: string,
): Promise<TuiSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for ${label}: ${JSON.stringify(store.getSnapshot())}`,
        ),
      );
    }, 15_000);
    const check = () => {
      const snapshot = store.getSnapshot();
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = store.subscribe(check);
    check();
  });
}

test("drives a streamed turn and a tool approval through the loopback app server", async () => {
  const storageDir = await mkdtemp(join(os.tmpdir(), "letta-tui-loopback-"));
  let server: EmbeddedAppServer | null = null;
  let store: TuiSessionStore | null = null;
  try {
    const backend = new LocalBackend({
      storageDir,
      executor: new DeterministicScriptedExecutor(),
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Loopback Agent",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    await settingsManager.initialize();
    settingsManager.setMemfsEnabled(agent.id, false);

    server = await startEmbeddedAppServer();
    expect(server.registered).toBe(false);
    const client = new LettaAgentClient({
      backend: "remote",
      url: server.url,
      WebSocket: WebSocket as unknown as SocketConstructor,
    });
    store = createTuiSessionStore({
      openSession: (canUseTool) =>
        client.createSession(agent.id, { canUseTool }),
    });
    await store.start();
    expect(store.getSnapshot().connection).toBe("connected");

    await store.send("hello loopback");
    const replied = await waitFor(
      store,
      (snapshot) =>
        snapshot.run === "idle" &&
        snapshot.items.some((item) => item.kind === "assistant"),
      "assistant reply",
    );
    expect(
      replied.items.map((item) => ("text" in item ? item.text.trim() : "")),
    ).toEqual(["hello loopback", "You said: hello loopback"]);
    expect(replied.committedCount).toBe(2);

    const marker = join(storageDir, "approved.txt");
    await store.send(
      `tool Bash ${JSON.stringify({ command: `touch ${marker} && echo loopback-tool-ok` })}`,
    );
    const asking = await waitFor(
      store,
      (snapshot) => snapshot.approvals.length === 1,
      "approval request",
    );
    expect(asking.run).toBe("awaiting_approval");
    const approval = asking.approvals[0];
    expect(approval?.toolName).toBe("Bash");
    expect(approval?.toolArgs).toContain("loopback-tool-ok");
    expect(existsSync(marker)).toBe(false);

    store.resolveApproval(approval?.requestId ?? "", { kind: "allow" });
    const finished = await waitFor(
      store,
      (snapshot) =>
        snapshot.run === "idle" &&
        snapshot.items.some(
          (item) => item.kind === "tool_call" && item.phase === "finished",
        ),
      "tool result",
    );
    const tool = finished.items.find((item) => item.kind === "tool_call");
    expect(tool).toMatchObject({ name: "Bash", resultOk: true });
    expect(tool?.kind === "tool_call" ? tool.resultText : "").toContain(
      "loopback-tool-ok",
    );
    expect(existsSync(marker)).toBe(true);
    expect(finished.committedCount).toBe(finished.items.length);
    expect(finished.epoch).toBe(0);
  } finally {
    store?.close();
    await server?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}, 30_000);
