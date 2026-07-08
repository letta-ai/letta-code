import {
  buildModelEntriesByHandle,
  type ChannelModelListEntry,
  getFallbackModelEntries,
  resolveModelHandles,
} from "@/channels/commands";
import type { ChannelModelPickerData } from "@/channels/types";

const SLACK_MODEL_PICKER_OPTION_LIMIT = 100;
const SLACK_MODEL_OPTION_TEXT_LIMIT = 75;
const SLACK_MODEL_OPTION_VALUE_LIMIT = 75;

export const SLACK_MODEL_SELECT_ACTION_ID = "letta_channel_model_select";

type SlackModelOption = {
  text: { type: "plain_text"; text: string; emoji?: boolean };
  value: string;
  description?: { type: "plain_text"; text: string; emoji?: boolean };
};

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateSlackPlainText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function getSlackModelOptionValue(entry: ChannelModelListEntry): string | null {
  const candidates = [entry.id, entry.handle].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return (
    candidates.find(
      (value) => value.length <= SLACK_MODEL_OPTION_VALUE_LIMIT,
    ) ?? null
  );
}

function buildSlackModelOption(
  entry: ChannelModelListEntry,
): SlackModelOption | null {
  const value = getSlackModelOptionValue(entry);
  if (!value) {
    return null;
  }

  const labelText =
    entry.handle === entry.label
      ? entry.label
      : `${entry.label} - ${entry.handle}`;
  const option: SlackModelOption = {
    text: {
      type: "plain_text",
      text: truncateSlackPlainText(labelText, SLACK_MODEL_OPTION_TEXT_LIMIT),
      emoji: true,
    },
    value,
  };
  if (entry.description) {
    option.description = {
      type: "plain_text",
      text: truncateSlackPlainText(
        entry.description,
        SLACK_MODEL_OPTION_TEXT_LIMIT,
      ),
      emoji: true,
    };
  }
  return option;
}

/**
 * Renders generic channel model-picker data as Slack Block Kit blocks.
 * Slack-specific rendering lives here so the shared channel/listener layers
 * stay vendor-neutral.
 */
export function buildSlackModelPickerBlocks(
  params: ChannelModelPickerData,
): unknown[] | undefined {
  const entries = params.entries as ChannelModelListEntry[];
  const byHandle = buildModelEntriesByHandle(entries);
  const availableHandleList = Array.isArray(params.availableHandles)
    ? params.availableHandles
    : null;
  const availableSet = availableHandleList
    ? new Set(availableHandleList)
    : null;
  const recentEntries = resolveModelHandles({
    handles: params.recentHandles ?? [],
    byHandle,
    availableHandles: availableSet,
  });
  const availableEntries = availableHandleList
    ? resolveModelHandles({ handles: availableHandleList, byHandle })
    : getFallbackModelEntries(byHandle);
  const optionEntries = [...recentEntries, ...availableEntries];
  const options: SlackModelOption[] = [];
  const seenValues = new Set<string>();
  for (const entry of optionEntries) {
    const option = buildSlackModelOption(entry);
    if (!option || seenValues.has(option.value)) {
      continue;
    }
    seenValues.add(option.value);
    options.push(option);
    if (options.length >= SLACK_MODEL_PICKER_OPTION_LIMIT) {
      break;
    }
  }

  if (options.length === 0) {
    return undefined;
  }

  const currentScope =
    params.current.scope === "agent" ? "agent" : "conversation";
  const currentHandleText = params.current.modelHandle
    ? `\nHandle: ${escapeSlackMrkdwn(params.current.modelHandle)}`
    : "";
  const currentHandle = params.current.modelHandle;
  const initialOption = options.find((option) => {
    const entry = optionEntries.find(
      (candidate) =>
        candidate.id === option.value || candidate.handle === option.value,
    );
    return currentHandle
      ? entry?.handle === currentHandle || option.value === currentHandle
      : false;
  });

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Current ${currentScope} model:* ${escapeSlackMrkdwn(params.current.modelLabel)}${currentHandleText}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Choose a model for this routed conversation:",
      },
      accessory: {
        type: "static_select",
        action_id: SLACK_MODEL_SELECT_ACTION_ID,
        placeholder: {
          type: "plain_text",
          text: "Select a model",
          emoji: true,
        },
        options,
        ...(initialOption ? { initial_option: initialOption } : {}),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Need another handle? Mention the app with `@agent /model <handle-or-id>`.",
        },
      ],
    },
  ];
}
