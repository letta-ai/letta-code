import type { ChannelResolvedMessageTarget } from "../pluginTypes";
import {
  listChannelTargets,
  loadTargetStore,
  upsertChannelTarget,
} from "../targets";
import type { SlackChannelAccount } from "../types";
import { createSlackWebApiClient } from "./webApiClient";

const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]+$/;
const SLACK_CHANNEL_TYPES = "public_channel,private_channel";
const SLACK_LIST_LIMIT = 200;

export type SlackConversationRecord = {
  id: string;
  name?: string;
};

type SlackReadClient = {
  conversations: {
    list: (args: {
      exclude_archived?: boolean;
      limit?: number;
      types?: string;
      cursor?: string;
    }) => Promise<{
      ok?: boolean;
      error?: string;
      channels?: Array<{
        id?: string;
        name?: string;
        is_archived?: boolean;
      }>;
      response_metadata?: {
        next_cursor?: string;
      };
    }>;
  };
};

type NormalizedSlackTarget =
  | {
      kind: "id";
      raw: string;
      chatId: string;
    }
  | {
      kind: "name";
      raw: string;
      name: string;
    };

function normalizeSlackChannelName(value: string): string {
  return value.trim().replace(/^#/, "").trim().toLowerCase();
}

function buildSlackChannelLabel(record: {
  name?: string;
  chatId: string;
}): string {
  const normalizedName =
    typeof record.name === "string"
      ? normalizeSlackChannelName(record.name)
      : "";
  return normalizedName ? `#${normalizedName}` : `#${record.chatId}`;
}

function normalizeSlackTarget(
  rawTarget: string,
): NormalizedSlackTarget | string {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return "Error: MessageChannel target cannot be empty.";
  }

  const prefixed = trimmed.match(/^([a-z_-]+):(.*)$/i);
  if (prefixed) {
    const prefix = prefixed[1]?.toLowerCase();
    const value = prefixed[2]?.trim() ?? "";
    if (!value) {
      return "Error: MessageChannel target cannot be empty.";
    }
    if (prefix === "channel") {
      return normalizeSlackTarget(value);
    }
    if (prefix === "user") {
      return 'Error: Slack proactive MessageChannel currently supports channel targets only. Use a channel target like "#general" or "channel:C123".';
    }
    return `Error: Unsupported Slack MessageChannel target prefix "${prefix}".`;
  }

  if (SLACK_CHANNEL_ID_PATTERN.test(trimmed)) {
    return {
      kind: "id",
      raw: trimmed,
      chatId: trimmed,
    };
  }

  const normalizedName = normalizeSlackChannelName(trimmed);
  if (!normalizedName) {
    return "Error: MessageChannel target cannot be empty.";
  }

  return {
    kind: "name",
    raw: trimmed,
    name: normalizedName,
  };
}

function findCachedSlackTarget(params: {
  accountId: string;
  normalizedTarget: NormalizedSlackTarget;
}): SlackConversationRecord | string | null {
  loadTargetStore("slack");
  const targets = listChannelTargets("slack", params.accountId);

  const matches = targets.filter((target) => {
    const normalizedTarget = params.normalizedTarget;
    if (normalizedTarget.kind === "id") {
      return (
        target.targetId === normalizedTarget.chatId ||
        target.chatId === normalizedTarget.chatId
      );
    }
    return normalizeSlackChannelName(target.label) === normalizedTarget.name;
  });

  if (matches.length > 1) {
    return `Error: Slack MessageChannel target "${params.normalizedTarget.raw}" is ambiguous for account "${params.accountId}".`;
  }

  const match = matches[0];
  if (!match) {
    return null;
  }

  return {
    id: match.chatId,
    name: normalizeSlackChannelName(match.label) || undefined,
  };
}

export async function listSlackChannels(
  account: SlackChannelAccount,
  existingClient?: SlackReadClient,
): Promise<SlackConversationRecord[]> {
  const client =
    existingClient ??
    (await createSlackWebApiClient<SlackReadClient>(account.botToken, {
      retryConfig: {
        retries: 0,
      },
    }));

  const channels: SlackConversationRecord[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.list({
      exclude_archived: true,
      limit: SLACK_LIST_LIMIT,
      types: SLACK_CHANNEL_TYPES,
      ...(cursor ? { cursor } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list Slack channels: ${response.error ?? "unknown error"}`,
      );
    }

    for (const channel of response.channels ?? []) {
      if (!channel?.id || channel.is_archived) {
        continue;
      }
      channels.push({
        id: channel.id,
        name: channel.name,
      });
    }

    const nextCursor = response.response_metadata?.next_cursor?.trim();
    cursor = nextCursor ? nextCursor : undefined;
  } while (cursor);

  return channels;
}

function findSlackChannelByTarget(params: {
  channels: SlackConversationRecord[];
  normalizedTarget: NormalizedSlackTarget;
}): SlackConversationRecord | string | null {
  const normalizedTarget = params.normalizedTarget;
  if (normalizedTarget.kind === "id") {
    return (
      params.channels.find(
        (channel) => channel.id === normalizedTarget.chatId,
      ) ?? null
    );
  }

  const matches = params.channels.filter(
    (channel) =>
      normalizeSlackChannelName(channel.name ?? "") === normalizedTarget.name,
  );
  if (matches.length > 1) {
    return `Error: Slack MessageChannel target "${normalizedTarget.raw}" matched multiple channels.`;
  }
  return matches[0] ?? null;
}

function cacheSlackChannelTarget(params: {
  accountId: string;
  channel: SlackConversationRecord;
}): void {
  const now = new Date().toISOString();
  upsertChannelTarget("slack", {
    accountId: params.accountId,
    targetId: params.channel.id,
    targetType: "channel",
    chatId: params.channel.id,
    label: buildSlackChannelLabel({
      name: params.channel.name,
      chatId: params.channel.id,
    }),
    discoveredAt: now,
    lastSeenAt: now,
  });
}

export async function resolveSlackMessageTarget(params: {
  account: SlackChannelAccount;
  target: string;
  lookupChannels?: (
    account: SlackChannelAccount,
  ) => Promise<SlackConversationRecord[]>;
}): Promise<ChannelResolvedMessageTarget> {
  const normalizedTarget = normalizeSlackTarget(params.target);
  if (typeof normalizedTarget === "string") {
    throw new Error(normalizedTarget);
  }

  const cachedTarget = findCachedSlackTarget({
    accountId: params.account.accountId,
    normalizedTarget,
  });
  if (typeof cachedTarget === "string") {
    throw new Error(cachedTarget);
  }
  if (cachedTarget) {
    return {
      chatId: cachedTarget.id,
      chatType: "channel",
      label: buildSlackChannelLabel({
        name: cachedTarget.name,
        chatId: cachedTarget.id,
      }),
    };
  }

  const channels = await (params.lookupChannels ?? listSlackChannels)(
    params.account,
  );
  const matchedChannel = findSlackChannelByTarget({
    channels,
    normalizedTarget,
  });
  if (typeof matchedChannel === "string") {
    throw new Error(matchedChannel);
  }
  if (!matchedChannel) {
    throw new Error(
      `Unknown Slack MessageChannel target "${normalizedTarget.raw}" for account "${params.account.accountId}".`,
    );
  }

  cacheSlackChannelTarget({
    accountId: params.account.accountId,
    channel: matchedChannel,
  });

  return {
    chatId: matchedChannel.id,
    chatType: "channel",
    label: buildSlackChannelLabel({
      name: matchedChannel.name,
      chatId: matchedChannel.id,
    }),
  };
}
