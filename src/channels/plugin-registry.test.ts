import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  buildDynamicMessageChannelSchema,
  clearDynamicMessageChannelToolCache,
} from "@/channels/message-tool";
import {
  __testClearUserChannelPluginCache,
  getChannelDisplayName,
  getChannelPluginMetadata,
  getSupportedChannelIds,
  isSupportedChannelId,
  loadChannelPlugin,
  reloadChannelPlugins,
} from "@/channels/plugin-registry";

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

test("reloadChannelPlugins can reload first-party channel plugins", async () => {
  reloadChannelPlugins();

  const plugin = await loadChannelPlugin("slack");

  expect(plugin.metadata.id).toBe("slack");
  expect(typeof plugin.createAdapter).toBe("function");
});

test("reloadChannelPlugins reloads changed user plugin modules", async () => {
  writeDemoChannel();
  expect((await loadChannelPlugin("demo")).metadata.displayName).toBe(
    "Demo Chat",
  );

  writeFileSync(
    join(channelsRoot, "demo", "plugin.mjs"),
    `export const channelPlugin = {
      metadata: { id: "demo", displayName: "Reloaded Demo Chat" },
      createAdapter(account) {
        return {
          id: "demo:" + account.accountId,
          channelId: "demo",
          accountId: account.accountId,
          name: "Reloaded Demo Chat",
          start: async () => {},
          stop: async () => {},
          isRunning: () => true,
          sendMessage: async () => ({ messageId: "demo-2" }),
          sendDirectReply: async () => {}
        };
      }
    };\n`,
  );

  reloadChannelPlugins();

  expect((await loadChannelPlugin("demo")).metadata.displayName).toBe(
    "Reloaded Demo Chat",
  );
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

test("user plugin configSchema is parsed from channel.json", () => {
  const channelDir = join(channelsRoot, "schemademo");
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify({
      id: "schemademo",
      displayName: "Schema Demo",
      entry: "./plugin.mjs",
      configSchema: {
        version: 1,
        fields: [
          { type: "text", key: "endpoint", label: "Endpoint", required: true },
          { type: "secret", key: "api_key", label: "API Key" },
          {
            type: "select",
            key: "region",
            label: "Region",
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
            ],
          },
          { type: "boolean", key: "debug", label: "Debug", default: false },
        ],
      },
    })}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    `export const channelPlugin = {
      metadata: { id: "schemademo", displayName: "Schema Demo" },
      createAdapter(account) {
        return {
          id: "schemademo:" + account.accountId,
          channelId: "schemademo",
          accountId: account.accountId,
          name: "Schema Demo",
          start: async () => {},
          stop: async () => {},
          isRunning: () => true,
          sendMessage: async () => ({ messageId: "sd-1" }),
          sendDirectReply: async () => {}
        };
      }
    };\n`,
  );

  expect(isSupportedChannelId("schemademo")).toBe(true);
  const metadata = getChannelPluginMetadata("schemademo");
  expect(metadata.configSchema).not.toBeUndefined();
  expect(metadata.configSchema?.version).toBe(1);
  expect(metadata.configSchema?.fields).toHaveLength(4);
  expect(metadata.configSchema?.fields[0]).toEqual({
    type: "text",
    key: "endpoint",
    label: "Endpoint",
    required: true,
  });
  expect(metadata.configSchema?.fields[1]).toEqual({
    type: "secret",
    key: "api_key",
    label: "API Key",
  });
});

test("user plugin with invalid configSchema still loads (schema dropped)", () => {
  const channelDir = join(channelsRoot, "badschema");
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify({
      id: "badschema",
      displayName: "Bad Schema",
      entry: "./plugin.mjs",
      configSchema: {
        version: 99,
        fields: [{ type: "unknown_type", key: "x", label: "X" }],
      },
    })}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    `export const channelPlugin = {
      metadata: { id: "badschema", displayName: "Bad Schema" },
      createAdapter(account) {
        return {
          id: "badschema:" + account.accountId,
          channelId: "badschema",
          accountId: account.accountId,
          name: "Bad Schema",
          start: async () => {},
          stop: async () => {},
          isRunning: () => true,
          sendMessage: async () => ({ messageId: "bs-1" }),
          sendDirectReply: async () => {}
        };
      }
    };\n`,
  );

  expect(isSupportedChannelId("badschema")).toBe(true);
  const metadata = getChannelPluginMetadata("badschema");
  expect(metadata.configSchema).toBeUndefined();
});

test("first-party custom channel has configSchema", () => {
  const metadata = getChannelPluginMetadata("custom");
  expect(metadata.configSchema).not.toBeUndefined();
  expect(metadata.configSchema?.version).toBe(1);
  expect(metadata.configSchema?.fields.length).toBeGreaterThan(0);
  const urlField = metadata.configSchema?.fields.find((f) => f.key === "url");
  expect(urlField).not.toBeUndefined();
  expect(urlField?.type).toBe("text");
  expect(urlField?.required).toBe(true);
});
