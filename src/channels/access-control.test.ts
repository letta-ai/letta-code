import { afterEach, describe, expect, test } from "bun:test";
import {
  buildChannelCommandDeniedMessage,
  buildChannelWhoamiMessage,
  type ChannelAccessAccount,
  canonicalizeChannelCommandName,
  canRunChannelCommand,
  evaluateChannelSenderAccess,
  resolveChannelAccessScope,
  resolveChannelCommandGate,
} from "@/channels/access-control";
import { tryHandleChannelSlashCommand } from "@/channels/commands";
import type { ChannelAdapter, ChannelChatType } from "@/channels/types";

const ENV_KEYS = [
  "LETTA_CHANNELS_ALLOWED_USERS",
  "LETTA_CHANNELS_ADMIN_USERS",
  "LETTA_CHANNELS_ALLOW_ALL_USERS",
  "LETTA_TESTCHAN_ALLOWED_USERS",
  "LETTA_TESTCHAN_ADMIN_USERS",
  "LETTA_TESTCHAN_ALLOW_ALL_USERS",
];

const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

function makeAccount(
  overrides: Partial<ChannelAccessAccount> = {},
): ChannelAccessAccount {
  return {
    accountId: "acct-1",
    dmPolicy: "open",
    allowedUsers: [],
    ...overrides,
  };
}

function evaluate(params: {
  account: ChannelAccessAccount;
  senderId?: string;
  chatType?: ChannelChatType;
  channelId?: string;
}) {
  return evaluateChannelSenderAccess({
    account: params.account,
    channelId: params.channelId ?? "testchan",
    senderId: params.senderId ?? "user-1",
    chatType: params.chatType,
  });
}

describe("resolveChannelAccessScope", () => {
  test("maps chat types to scopes", () => {
    expect(resolveChannelAccessScope("channel")).toBe("group");
    expect(resolveChannelAccessScope("direct")).toBe("dm");
    expect(resolveChannelAccessScope(undefined)).toBe("dm");
  });
});

describe("evaluateChannelSenderAccess — DM scope", () => {
  test("open policy allows anyone", () => {
    expect(evaluate({ account: makeAccount() })).toBe("allow");
  });

  test("allowlist policy denies unlisted and allows listed senders", () => {
    const account = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["user-2"],
    });
    expect(evaluate({ account })).toBe("deny");
    expect(evaluate({ account, senderId: "user-2" })).toBe("allow");
  });

  test("pairing policy asks unapproved senders to pair", () => {
    const account = makeAccount({ dmPolicy: "pairing" });
    expect(evaluate({ account })).toBe("pair");
  });

  test("pairing policy treats allowlisted senders as approved", () => {
    const account = makeAccount({
      dmPolicy: "pairing",
      allowedUsers: ["user-1"],
    });
    expect(evaluate({ account })).toBe("allow");
  });

  test("admin users are implicitly allowlisted", () => {
    const account = makeAccount({
      dmPolicy: "allowlist",
      adminUsers: ["user-1"],
    });
    expect(evaluate({ account })).toBe("allow");
  });

  test("wildcard allowlist entry allows everyone", () => {
    const account = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["*"],
    });
    expect(evaluate({ account, senderId: "anyone" })).toBe("allow");
  });

  test("slack legacy pairing default behaves as open", () => {
    const account = makeAccount({ dmPolicy: "pairing" });
    expect(evaluate({ account, channelId: "slack" })).toBe("allow");
  });

  test("slack explicit allowlist is enforced", () => {
    const account = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["user-2"],
    });
    expect(evaluate({ account, channelId: "slack" })).toBe("deny");
  });
});

describe("evaluateChannelSenderAccess — group scope", () => {
  test("groups stay open by default", () => {
    const account = makeAccount({ dmPolicy: "pairing" });
    expect(evaluate({ account, chatType: "channel" })).toBe("allow");
  });

  test("groupPolicy allowlist denies unlisted group senders silently", () => {
    const account = makeAccount({
      groupPolicy: "allowlist",
      allowedUsers: ["user-2"],
    });
    expect(evaluate({ account, chatType: "channel" })).toBe("deny");
    expect(evaluate({ account, chatType: "channel", senderId: "user-2" })).toBe(
      "allow",
    );
  });

  test("groups never receive a pair decision", () => {
    const account = makeAccount({
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    });
    expect(evaluate({ account, chatType: "channel" })).toBe("deny");
  });
});

describe("evaluateChannelSenderAccess — env allowlists", () => {
  test("global env allowlist restricts every scope once configured", () => {
    process.env.LETTA_CHANNELS_ALLOWED_USERS = "user-9";
    const account = makeAccount();
    expect(evaluate({ account })).toBe("deny");
    expect(evaluate({ account, chatType: "channel" })).toBe("deny");
    expect(evaluate({ account, senderId: "user-9" })).toBe("allow");
    expect(evaluate({ account, chatType: "channel", senderId: "user-9" })).toBe(
      "allow",
    );
  });

  test("per-channel env allowlist merges with account allowlist", () => {
    process.env.LETTA_TESTCHAN_ALLOWED_USERS = "user-7, user-8";
    const account = makeAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["user-2"],
    });
    expect(evaluate({ account, senderId: "user-7" })).toBe("allow");
    expect(evaluate({ account, senderId: "user-2" })).toBe("allow");
    expect(evaluate({ account, senderId: "user-3" })).toBe("deny");
  });

  test("env allowlist overrides slack legacy-open pairing default", () => {
    process.env.LETTA_CHANNELS_ALLOWED_USERS = "user-9";
    const account = makeAccount({ dmPolicy: "pairing" });
    expect(evaluate({ account, channelId: "slack" })).toBe("deny");
  });

  test("allow-all env flag bypasses every restriction", () => {
    process.env.LETTA_TESTCHAN_ALLOW_ALL_USERS = "1";
    const account = makeAccount({
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowedUsers: [],
    });
    expect(evaluate({ account })).toBe("allow");
    expect(evaluate({ account, chatType: "channel" })).toBe("allow");
  });
});

describe("channel command tiers", () => {
  test("gating is disabled until an admin is configured", () => {
    const gate = resolveChannelCommandGate({
      account: makeAccount(),
      channelId: "testchan",
      senderId: "user-1",
    });
    expect(gate.enabled).toBe(false);
    expect(canRunChannelCommand(gate, "pause")).toBe(true);
    expect(canRunChannelCommand(gate, "model")).toBe(true);
  });

  test("admins can run everything; users get the read-only floor", () => {
    const account = makeAccount({ adminUsers: ["admin-1"] });
    const adminGate = resolveChannelCommandGate({
      account,
      channelId: "testchan",
      senderId: "admin-1",
    });
    expect(adminGate.isAdmin).toBe(true);
    expect(canRunChannelCommand(adminGate, "pause")).toBe(true);

    const userGate = resolveChannelCommandGate({
      account,
      channelId: "testchan",
      senderId: "user-1",
    });
    expect(userGate.enabled).toBe(true);
    expect(userGate.isAdmin).toBe(false);
    expect(canRunChannelCommand(userGate, "help")).toBe(true);
    expect(canRunChannelCommand(userGate, "status")).toBe(true);
    expect(canRunChannelCommand(userGate, "whoami")).toBe(true);
    expect(canRunChannelCommand(userGate, "pause")).toBe(false);
    expect(canRunChannelCommand(userGate, "model")).toBe(false);
  });

  test("userAllowedCommands extends the floor and normalizes names", () => {
    const account = makeAccount({
      adminUsers: ["admin-1"],
      userAllowedCommands: ["/Model", "cancel"],
    });
    const gate = resolveChannelCommandGate({
      account,
      channelId: "testchan",
      senderId: "user-1",
    });
    expect(canRunChannelCommand(gate, "model")).toBe(true);
    expect(canRunChannelCommand(gate, "cancel")).toBe(true);
    expect(canRunChannelCommand(gate, "pause")).toBe(false);
  });

  test("env admin lists activate gating", () => {
    process.env.LETTA_TESTCHAN_ADMIN_USERS = "admin-9";
    const gate = resolveChannelCommandGate({
      account: makeAccount(),
      channelId: "testchan",
      senderId: "user-1",
    });
    expect(gate.enabled).toBe(true);
    expect(gate.isAdmin).toBe(false);
    expect(canRunChannelCommand(gate, "pause")).toBe(false);
  });

  test("reflect alias canonicalizes to reflection", () => {
    expect(canonicalizeChannelCommandName("reflect")).toBe("reflection");
    expect(canonicalizeChannelCommandName("/PAUSE")).toBe("pause");
  });
});

describe("whoami and denial messages", () => {
  const msg = {
    channel: "testchan",
    senderId: "user-1",
    senderName: "Sam",
    chatType: "direct" as ChannelChatType,
  };

  test("whoami reports unrestricted tier when gating is off", () => {
    const text = buildChannelWhoamiMessage(msg, undefined);
    expect(text).toContain("Sam (user-1)");
    expect(text).toContain("DM");
    expect(text).toContain("Tier: unrestricted");
  });

  test("whoami reports user tier with runnable commands", () => {
    const gate = resolveChannelCommandGate({
      account: makeAccount({
        adminUsers: ["admin-1"],
        userAllowedCommands: ["model"],
      }),
      channelId: "testchan",
      senderId: "user-1",
    });
    const text = buildChannelWhoamiMessage(
      { ...msg, chatType: "channel" },
      gate,
    );
    expect(text).toContain("group/channel");
    expect(text).toContain("Tier: user");
    expect(text).toContain("/help, /status, /whoami, /model");
  });

  test("denial message lists the runnable floor", () => {
    const gate = resolveChannelCommandGate({
      account: makeAccount({ adminUsers: ["admin-1"] }),
      channelId: "testchan",
      senderId: "user-1",
    });
    const text = buildChannelCommandDeniedMessage("testchan", "pause", gate);
    expect(text).toContain("/pause is limited to admins");
    expect(text).toContain("/help, /status, /whoami");
  });
});

describe("tryHandleChannelSlashCommand gating", () => {
  function makeAdapter(replies: { chatId: string; text: string }[]) {
    return {
      id: "testchan",
      channelId: "testchan",
      name: "testchan",
      async start() {},
      async stop() {},
      isRunning: () => true,
      async sendMessage() {
        return { messageId: "sent-1" };
      },
      async sendDirectReply(chatId: string, text: string) {
        replies.push({ chatId, text });
      },
    } as unknown as ChannelAdapter;
  }

  const baseMsg = {
    channel: "testchan",
    chatId: "chat-1",
    senderId: "user-1",
    senderName: "Sam",
    text: "/pause",
    timestamp: 0,
  };

  test("non-admins are blocked from gated commands", async () => {
    const replies: { chatId: string; text: string }[] = [];
    const gate = resolveChannelCommandGate({
      account: makeAccount({ adminUsers: ["admin-1"] }),
      channelId: "testchan",
      senderId: "user-1",
    });
    const handled = await tryHandleChannelSlashCommand(
      makeAdapter(replies),
      baseMsg,
      { commandGate: gate },
    );
    expect(handled).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain("limited to admins");
  });

  test("whoami stays reachable for gated users", async () => {
    const replies: { chatId: string; text: string }[] = [];
    const gate = resolveChannelCommandGate({
      account: makeAccount({ adminUsers: ["admin-1"] }),
      channelId: "testchan",
      senderId: "user-1",
    });
    const handled = await tryHandleChannelSlashCommand(
      makeAdapter(replies),
      { ...baseMsg, text: "/whoami" },
      { commandGate: gate },
    );
    expect(handled).toBe(true);
    expect(replies[0]?.text).toContain("Tier: user");
  });

  test("admins pass the gate through to normal handling", async () => {
    const replies: { chatId: string; text: string }[] = [];
    const gate = resolveChannelCommandGate({
      account: makeAccount({ adminUsers: ["admin-1"] }),
      channelId: "testchan",
      senderId: "admin-1",
    });
    const handled = await tryHandleChannelSlashCommand(
      makeAdapter(replies),
      { ...baseMsg, text: "/help" },
      { commandGate: gate },
    );
    expect(handled).toBe(true);
    expect(replies[0]?.text).toContain("connected to Letta Code");
  });
});
