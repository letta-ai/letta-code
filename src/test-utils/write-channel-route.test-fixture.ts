import { expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { getChannelRoutingPath } from "@/channels/config";
import { addRoute } from "@/channels/routing";

test("writes fixture state through production path resolvers", () => {
  const testHome = process.env.LETTA_TEST_HOME;
  if (!testHome) throw new Error("Test home preload did not run");
  mock.restore();
  addRoute("slack", {
    accountId: "fixture-account",
    chatId: "fixture-chat",
    chatType: "channel",
    threadId: "fixture-thread",
    agentId: "fixture-agent",
    conversationId: "fixture-conversation",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(getChannelRoutingPath("slack")).toStartWith(testHome);

  const memoryDir = process.env.MEMORY_DIR;
  if (!memoryDir) throw new Error("MEMORY_DIR was not redirected");
  expect(memoryDir).toStartWith(testHome);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(`${memoryDir}/fixture-write`, "isolated\n", "utf-8");
});
