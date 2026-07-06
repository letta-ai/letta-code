import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getAllRoutes,
  getRoute,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
  removeRoutesForScope,
  subscribeChannelRoutesChanged,
  saveRoutes,
} from "@/channels/routing";

describe("routing", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
  });

  afterEach(() => {
    clearAllRoutes();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
  });

  test("adds and retrieves a route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const route = getRoute("telegram", "1001");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
    expect(route?.conversationId).toBe("conv-1");
  });

  test("normalizes numeric Telegram Chat IDs before persistence", () => {
    addRoute("telegram", {
      chatId: " -1003904563283 ",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(getRoute("telegram", "-1003904563283")?.chatId).toBe(
      "-1003904563283",
    );
  });

  test("rejects labeled Telegram Chat IDs before persistence", () => {
    expect(() =>
      addRoute("telegram", {
        chatId: "Chat ID: 7945451305",
        agentId: "agent-a",
        conversationId: "conv-1",
        enabled: true,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow("Paste only the numeric Telegram Chat ID");
    expect(getAllRoutes()).toHaveLength(0);
  });

  test("notifies subscribers after persisted route changes", () => {
    const changedChannels: string[] = [];
    const unsubscribe = subscribeChannelRoutesChanged((channelId) => {
      changedChannels.push(channelId);
    });

    try {
      addRoute("telegram", {
        chatId: "1001",
        agentId: "agent-a",
        conversationId: "conv-1",
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      removeRoute("telegram", "1001");
    } finally {
      unsubscribe();
    }

    expect(changedChannels).toEqual(["telegram", "telegram"]);
  });

  test("returns null for non-existent route", () => {
    expect(getRoute("telegram", "nonexistent")).toBeNull();
  });

  test("returns null for disabled route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: false,
      createdAt: new Date().toISOString(),
    });

    expect(getRoute("telegram", "1001")).toBeNull();
  });

  test("removes a route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(removeRoute("telegram", "1001")).toBe(true);
    expect(getRoute("telegram", "1001")).toBeNull();
  });

  test("removeRoutesForScope removes matching routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "1002",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "1003",
      agentId: "agent-b",
      conversationId: "conv-2",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const removed = removeRoutesForScope("telegram", "agent-a", "conv-1");
    expect(removed).toBe(2);

    expect(getRoute("telegram", "1001")).toBeNull();
    expect(getRoute("telegram", "1002")).toBeNull();
    expect(getRoute("telegram", "1003")).not.toBeNull();
  });

  test("getRoutesForChannel returns channel-specific routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const routes = getRoutesForChannel("telegram");
    expect(routes).toHaveLength(1);

    const slackRoutes = getRoutesForChannel("slack");
    expect(slackRoutes).toHaveLength(0);
  });

  test("getAllRoutes returns all routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(getAllRoutes()).toHaveLength(1);
  });
});

describe("routing disk format migration (#3076)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "letta-routing-migration-"));
    __testOverrideChannelsRoot(tmpRoot);
    // Do NOT install the load/save overrides — these tests exercise real disk I/O.
    clearAllRoutes();
  });

  afterEach(() => {
    clearAllRoutes();
    __testOverrideChannelsRoot(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("new writes go to routing.json (not routing.yaml)", () => {
    loadRoutes("telegram");
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    saveRoutes("telegram");

    expect(existsSync(join(tmpRoot, "telegram", "routing.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "telegram", "routing.yaml"))).toBe(false);
  });

  test("legacy routing.yaml is migrated to routing.json on load", () => {
    const channelDir = join(tmpRoot, "telegram");
    mkdirSync(channelDir, { recursive: true });
    const legacy = {
      routes: [
        { chatId: "chat-1", agentId: "agent-a", conversationId: "conv-1" },
      ],
    };
    writeFileSync(
      join(channelDir, "routing.yaml"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf-8",
    );

    loadRoutes("telegram");

    // Routes are loaded into memory.
    expect(getRoute("telegram", "chat-1")?.conversationId).toBe("conv-1");
    // File is renamed to .json and the legacy file is gone.
    expect(existsSync(join(channelDir, "routing.json"))).toBe(true);
    expect(existsSync(join(channelDir, "routing.yaml"))).toBe(false);
  });

  test("an already-migrated routing.json is loaded without touching any yaml", () => {
    const channelDir = join(tmpRoot, "telegram");
    mkdirSync(channelDir, { recursive: true });
    const data = {
      routes: [
        { chatId: "chat-1", agentId: "agent-a", conversationId: "conv-9" },
      ],
    };
    writeFileSync(
      join(channelDir, "routing.json"),
      `${JSON.stringify(data, null, 2)}\n`,
      "utf-8",
    );

    loadRoutes("telegram");

    expect(getRoute("telegram", "chat-1")?.conversationId).toBe("conv-9");
    expect(existsSync(join(channelDir, "routing.yaml"))).toBe(false);
  });

  test("a corrupted legacy yaml is left in place rather than risk data loss", () => {
    const channelDir = join(tmpRoot, "telegram");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(channelDir, "routing.yaml"),
      "{ not valid json",
      "utf-8",
    );

    // Should not throw.
    loadRoutes("telegram");

    // Nothing loaded.
    expect(getRoute("telegram", "chat-1")).toBeNull();
    // No .json written (would clobber), legacy file untouched.
    expect(existsSync(join(channelDir, "routing.json"))).toBe(false);
    expect(existsSync(join(channelDir, "routing.yaml"))).toBe(true);
  });
});
