import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelSubagentNoticeDelivery } from "./gateway-subagent-delivery";
import {
  parseSubagentNoticeConfig,
  readSubagentNoticeRoutes,
} from "./subagent-notice-config";
import type { ChannelAdapter } from "./types";

const route = {
  channel: "signal",
  accountId: "synthetic-account",
  chatId: "synthetic-chat",
  threadId: null,
  agentId: "synthetic-agent",
  conversationId: "synthetic-conversation",
};

test("persisted consent requires every exact route field and a version", () => {
  expect(parseSubagentNoticeConfig({ version: 1, routes: [route] })).toEqual([
    route,
  ]);
  for (const value of [
    null,
    true,
    {},
    { version: 2, routes: [route] },
    { version: 1, routes: [route], enabled: false },
    { version: 1, routes: [{ ...route, threadId: undefined }] },
    ...Object.keys(route)
      .filter((key) => key !== "threadId")
      .flatMap((key) =>
        [undefined, "", "*", 4].map((value) => ({
          version: 1,
          routes: [{ ...route, [key]: value }],
        })),
      ),
    { version: 1, routes: [route, { ...route, typo: true }] },
  ]) {
    expect(parseSubagentNoticeConfig(value)).toEqual([]);
  }
});

test("synthetic file edits enable and revoke consent at delivery without restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "letta-notice-config-"));
  const path = join(root, "subagent-notices.json");
  const sent: unknown[] = [];
  const adapter = {
    isRunning: () => true,
    sendMessage: async (message: unknown) => {
      sent.push(message);
      return { messageId: "synthetic" };
    },
  } as unknown as ChannelAdapter;
  const delivery = createChannelSubagentNoticeDelivery(
    {
      resolveTurnSourcesForScope: () => [route],
      getAdapter: () => adapter,
    },
    () => readSubagentNoticeRoutes(path),
  );
  try {
    expect(delivery.routes).toEqual([]);
    await delivery.send(route, "**Dispatched subagent**\nInspect routing");
    expect(sent).toHaveLength(0);
    writeFileSync(path, JSON.stringify({ version: 1, routes: [route] }));
    expect(delivery.routes).toEqual([route]);
    await delivery.send(route, "**Dispatched subagent**\nInspect routing");
    expect(sent).toHaveLength(1);
    writeFileSync(path, "invalid JSON");
    expect(delivery.routes).toEqual([]);
    await delivery.send(route, "must not send");
    expect(sent).toHaveLength(1);
    rmSync(path);
    expect(delivery.routes).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
