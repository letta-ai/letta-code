import type {
  ChannelTurnSource,
  InboundChannelMessage,
} from "@/channels/types";

export type SlackAppConstructor = typeof import("@slack/bolt").App;

export type SlackBoltModule = typeof import("@slack/bolt") & {
  default?: unknown;
};

export type SlackWriteClient = {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: SlackBlock[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: SlackBlock[];
    }) => Promise<{ ts?: string }>;
  };
  assistant?: {
    threads?: {
      setStatus?: (args: {
        channel_id: string;
        thread_ts: string;
        status: string;
        loading_messages?: string[];
      }) => Promise<unknown>;
    };
  };
  reactions: {
    add: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
    remove: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
  };
  files: {
    getUploadURLExternal: (args: {
      filename: string;
      length: number;
    }) => Promise<{
      ok?: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    }>;
    completeUploadExternal: (args: {
      files: Array<{ id: string; title: string }>;
      channel_id: string;
      initial_comment?: string;
      thread_ts?: string;
    }) => Promise<{ ok?: boolean; error?: string }>;
  };
};

export type SlackReactionEvent = {
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  user?: string;
  item_user?: string;
  reaction?: string;
  event_ts?: string;
  team?: string;
  team_id?: string;
  user_team?: string;
};

export type SlackApprovalActionPayload = {
  requestId?: string;
  decision?: "allow" | "deny";
};

export type SlackApprovalPromptState = {
  source: ChannelTurnSource;
  messageTs: string;
};

export type SlackCommandPayload = {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  channel_name?: string;
  team_id?: string;
  trigger_id?: string;
};

export type SlackTextObject = {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
};

export type SlackOption = {
  text: SlackTextObject;
  value: string;
  description?: SlackTextObject;
};

export type SlackButtonElement = {
  type: "button";
  text: SlackTextObject;
  action_id: string;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
};

export type SlackStaticSelectElement = {
  type: "static_select";
  action_id: string;
  placeholder?: SlackTextObject;
  options: SlackOption[];
  initial_option?: SlackOption;
};

export type SlackBlockElement = SlackButtonElement | SlackStaticSelectElement;

export type SlackBlock =
  | {
      type: "section";
      text: SlackTextObject;
      accessory?: SlackBlockElement;
    }
  | {
      type: "markdown";
      text: string;
    }
  | {
      type: "context";
      elements: SlackTextObject[];
    }
  | {
      type: "divider";
    }
  | {
      type: "actions";
      elements: SlackBlockElement[];
    };

export type SlackDebounceSource = "message" | "app_mention";

export type SlackDebounceRawInput = {
  channel: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
  user?: string;
  bot_id?: string;
};

export type SlackDebounceEntry = {
  inbound: InboundChannelMessage;
  raw: SlackDebounceRawInput;
  opts: { source: SlackDebounceSource; wasMentioned: boolean };
};
