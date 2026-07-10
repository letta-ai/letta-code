import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ChannelDefaultPermissionMode,
  ChannelModelPickerData,
  ChannelRoute,
  ChannelTurnSource,
} from "./types";

export interface ChannelInboundDelivery {
  route: ChannelRoute;
  content: MessageCreate["content"];
  turnSources?: ChannelTurnSource[];
  defaultPermissionMode?: ChannelDefaultPermissionMode;
}

export type ChannelMessageHandler = (delivery: ChannelInboundDelivery) => void;

export type ChannelCancelHandler = (params: {
  runtime: { agent_id: string; conversation_id: string };
}) => Promise<boolean>;

export type ChannelReflectionHandler = (params: {
  runtime: { agent_id: string; conversation_id: string };
}) => Promise<{ handled: boolean; text?: string }>;

export type ChannelModelHandler = (params: {
  channelId: string;
  runtime: { agent_id: string; conversation_id: string };
  modelIdentifier?: string;
}) => Promise<{
  handled: boolean;
  text?: string;
  modelPicker?: ChannelModelPickerData;
}>;

export type ChannelReloadHandler = (params: {
  runtime: { agent_id: string; conversation_id: string };
}) => Promise<{ handled: boolean; text?: string }>;
