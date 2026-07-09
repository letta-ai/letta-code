import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  listChannelTargets,
  upsertChannelTarget,
} from "@/channels/targets";
import type { SlackChannelAccount } from "@/channels/types";
import {
  listSlackChannels,
  openSlackDirectMessage,
  resolveSlackMessageTarget,
} from "./target-resolution";

function makeSlackAccount(accountId: string): SlackChannelAccount {
  return {
    channel: "slack",
    accountId,
    displayName: `Slack ${accountId}`,
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    mode: "socket",
    botToken: `xoxb-${accountId}`,
    appToken: `xapp-${accountId}`,
    agentId: "agent-1",
    defaultPermissionMode: "standard",
  };
}

describe("Slack MessageChannel target resolution", () => {
  afterEach(() => {
    clearTargetStores();
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
  });

  test("keeps cached target matching scoped to the selected account", async () => {
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});

    upsertChannelTarget("slack", {
      accountId: "docsbot",
      targetId: "C111",
      targetType: "channel",
      chatId: "C111",
      label: "#eng",
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
    });
    upsertChannelTarget("slack", {
      accountId: "supportbot",
      targetId: "C222",
      targetType: "channel",
      chatId: "C222",
      label: "#eng",
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
    });

    const resolved = await resolveSlackMessageTarget({
      account: makeSlackAccount("supportbot"),
      target: "#eng",
    });

    expect(resolved).toEqual({
      chatId: "C222",
      chatType: "channel",
      label: "#eng",
    });
  });

  test("resolves live lookup matches by raw Slack channel id and warms the cache", async () => {
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});

    const lookupChannels = mock(async () => [
      { id: "C777", name: "eng" },
      { id: "C888", name: "sales" },
    ]);

    const resolved = await resolveSlackMessageTarget({
      account: makeSlackAccount("docsbot"),
      target: "channel:C777",
      lookupChannels,
    });

    expect(resolved).toEqual({
      chatId: "C777",
      chatType: "channel",
      label: "#eng",
    });
    expect(lookupChannels).toHaveBeenCalledTimes(1);
    expect(listChannelTargets("slack", "docsbot")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "docsbot",
          targetId: "C777",
          chatId: "C777",
          label: "#eng",
        }),
      ]),
    );
  });

  test("paginates Slack channel listing until exhaustion", async () => {
    const list = mock()
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C100", name: "general" }],
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C200", name: "eng" }],
        response_metadata: { next_cursor: "" },
      });

    const channels = await listSlackChannels(makeSlackAccount("docsbot"), {
      conversations: {
        list,
      },
    });

    expect(channels).toEqual([
      { id: "C100", name: "general" },
      { id: "C200", name: "eng" },
    ]);
    expect(list).toHaveBeenNthCalledWith(1, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
      cursor: "cursor-2",
    });
  });

  test("opens Slack DMs for explicit user targets", async () => {
    const openDirectMessage = mock(async () => ({
      id: "D12345678",
      name: "U12345678",
    }));

    const resolved = await resolveSlackMessageTarget({
      account: makeSlackAccount("docsbot"),
      target: "user:U12345678",
      openDirectMessage,
    });

    expect(resolved).toEqual({
      chatId: "D12345678",
      chatType: "direct",
      label: "@U12345678",
    });
    expect(openDirectMessage).toHaveBeenCalledWith(
      makeSlackAccount("docsbot"),
      "U12345678",
    );
  });

  test("treats raw Slack user ids as direct-message targets", async () => {
    const lookupChannels = mock(async () => {
      throw new Error("user targets should not list channels");
    });
    const openDirectMessage = mock(async () => ({
      id: "D87654321",
      name: "U87654321",
    }));

    const resolved = await resolveSlackMessageTarget({
      account: makeSlackAccount("docsbot"),
      target: "U87654321",
      lookupChannels,
      openDirectMessage,
    });

    expect(resolved).toEqual({
      chatId: "D87654321",
      chatType: "direct",
      label: "@U87654321",
    });
    expect(lookupChannels).not.toHaveBeenCalled();
    expect(openDirectMessage).toHaveBeenCalledWith(
      makeSlackAccount("docsbot"),
      "U87654321",
    );
  });

  test("opens Slack DMs through conversations.open", async () => {
    const open = mock(async () => ({
      ok: true,
      channel: { id: "D12345678" },
    }));

    const resolved = await openSlackDirectMessage(
      makeSlackAccount("docsbot"),
      "U12345678",
      {
        conversations: { open },
      },
    );

    expect(resolved).toEqual({ id: "D12345678", name: "U12345678" });
    expect(open).toHaveBeenCalledWith({ users: "U12345678" });
  });

  test("rejects malformed Slack user targets", async () => {
    await expect(
      resolveSlackMessageTarget({
        account: makeSlackAccount("docsbot"),
        target: "user:cameron",
      }),
    ).rejects.toThrow(
      'Error: Slack user targets must be Slack user IDs like "user:U12345678".',
    );
  });
});
