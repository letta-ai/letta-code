import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "../../channels/config";
import {
  buildDynamicMessageChannelSchema,
  clearDynamicMessageChannelToolCache,
} from "../../channels/messageTool";
import {
  __testClearUserChannelPluginCache,
  getChannelDisplayName,
  getChannelPluginMetadata,
  getSupportedChannelIds,
  isSupportedChannelId,
  loadChannelPlugin,
} from "../../channels/pluginRegistry";

let channelsRoot: string;

function writeDemoChannel(): void {
  const channelDir = join(channelsRoot, "demo");
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify(
      {
        id: "demo",
        displayName: "Demo Chat",
        entry: "./plugin.mjs",
        runtimePackages: ["demo-runtime@1.0.0"],
        runtimeModules: ["demo-runtime"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    `export const channelPlugin = {
      metadata: {
        id: "demo",
        displayName: "Demo Chat",
        runtimePackages: ["demo-runtime@1.0.0"],
        runtimeModules: ["demo-runtime"]
      },
      createAdapter(account) {
        return {
          id: "demo:" + account.accountId,
          channelId: "demo",
          accountId: account.accountId,
          name: "Demo Chat",
          start: async () => {},
          stop: async () => {},
          isRunning: () => true,
          sendMessage: async () => ({ messageId: "demo-1" }),
          sendDirectReply: async () => {}
        };
      },
      messageActions: {
        describeMessageTool() {
          return {
            actions: ["wave"],
            schema: { properties: { intensity: { type: "string" } } }
          };
        },
        handleAction: async () => "ok"
      }
    };\n`,
  );
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-plugins-"));
  __testOverrideChannelsRoot(channelsRoot);
  __testClearUserChannelPluginCache();
  clearDynamicMessageChannelToolCache();
});

afterEach(() => {
  __testOverrideChannelsRoot(null);
  __testClearUserChannelPluginCache();
  clearDynamicMessageChannelToolCache();
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("discovers user channel plugins from channel.json manifests", async () => {
  writeDemoChannel();

  expect(isSupportedChannelId("demo")).toBe(true);
  expect(getSupportedChannelIds()).toContain("demo");
  expect(getChannelDisplayName("demo")).toBe("Demo Chat");
  expect(getChannelPluginMetadata("demo")).toMatchObject({
    id: "demo",
    source: "user",
    firstParty: false,
  });

  const plugin = await loadChannelPlugin("demo");
  expect(plugin.metadata).toMatchObject({
    id: "demo",
    displayName: "Demo Chat",
    source: "user",
    firstParty: false,
  });
});

test("user plugins can extend the MessageChannel action schema", async () => {
  writeDemoChannel();

  const schema = await buildDynamicMessageChannelSchema(
    {
      type: "object",
      properties: {
        action: { type: "string" },
        channel: { type: "string" },
        chat_id: { type: "string" },
      },
      required: ["action", "channel", "chat_id"],
      additionalProperties: false,
    },
    { channels: [{ channelId: "demo", accountId: "acct-demo" }] },
  );

  const properties = schema.properties as Record<
    string,
    Record<string, unknown> & { enum?: string[] }
  >;
  expect(properties.channel?.enum).toEqual(["demo"]);
  expect(properties.action?.enum).toEqual(["send", "wave"]);
  expect(properties.intensity).toEqual({ type: "string" });
});
