/**
 * End to end over a real loopback App Server with capability-token auth: the
 * caller reaches a `direct:<name>` computer without any Letta Cloud relay.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { DirectComputer } from "@/backend/direct-computers";
import { launchRemoteExternalCodingAgent } from "@/tools/impl/remote-external-coding-agent";
import { spawnBackgroundSubagentTask } from "@/tools/impl/task";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";

const saved = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LETTA_DISABLE_MODS: process.env.LETTA_DISABLE_MODS,
  LETTA_DISABLE_CRON_SCHEDULER: process.env.LETTA_DISABLE_CRON_SCHEDULER,
};
let dir: string;
let handle: AppServerHandle | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(os.tmpdir(), "letta-direct-launch-"));
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function serve(): Promise<{ tokenFile: string; url: string }> {
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "direct-test-token\n", "utf8");
  handle = await startAppServer({
    listen: "ws://127.0.0.1:0",
    websocketAuth: parseAppServerWebsocketAuthSettings({
      wsAuth: "capability-token",
      wsTokenFile: tokenFile,
    }),
  });
  return { tokenFile, url: handle.controlUrl };
}

function launch(computer: DirectComputer) {
  return launchRemoteExternalCodingAgent(
    {
      type: "codex",
      computer: `direct:${computer.name}`,
      prompt: "Say hi",
      description: "Say hi",
      parentScope: { agentId: "agent-direct", conversationId: "conv-direct" },
    },
    {
      spawn: spawnBackgroundSubagentTask,
      resolveDirectComputer: () => computer,
    },
  );
}

describe("direct computer launch over a real App Server", () => {
  test("authenticates, reads capabilities and relays the remote launch result", async () => {
    const { tokenFile, url } = await serve();
    // No codex on the server's PATH: the remote launch fails at startup,
    // which proves the full launch_subagent round trip.
    process.env.PATH = join(dir, "bin");
    process.env.HOME = dir;
    const result = await launch({ name: "loop", url, tokenFile });
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("couldn't find or start Codex"),
    });
  }, 30_000);

  test("a wrong token is rejected before any launch", async () => {
    const { url } = await serve();
    const wrong = join(dir, "wrong");
    await writeFile(wrong, "not-the-token\n", "utf8");
    const result = await launch({ name: "loop", url, tokenFile: wrong });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toStartWith("Can't reach direct:loop");
      expect(result.error).not.toContain("not-the-token");
    }
  });
});
