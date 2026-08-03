import type {
  RuntimeScope,
  WsProtocolCommand,
  WsProtocolMessage,
} from "./protocol_v2";

export const CHANNEL_SERVICE_COMMAND_TYPES = [
  "channels_list",
  "channel_accounts_list",
  "channel_account_create",
  "channel_account_update",
  "channel_account_bind",
  "channel_account_unbind",
  "channel_account_delete",
  "channel_account_start",
  "channel_account_stop",
  "channel_get_config",
  "channel_set_config",
  "channel_start",
  "channel_stop",
  "channel_pairings_list",
  "channel_pairing_bind",
  "channel_routes_list",
  "channel_targets_list",
  "channel_target_bind",
  "channel_route_update",
  "channel_route_remove",
] as const satisfies readonly WsProtocolCommand["type"][];

const CHANNEL_SERVICE_COMMAND_TYPE_SET = new Set<string>(
  CHANNEL_SERVICE_COMMAND_TYPES,
);

export function isChannelServiceCommandType(
  value: unknown,
): value is (typeof CHANNEL_SERVICE_COMMAND_TYPES)[number] {
  return (
    typeof value === "string" && CHANNEL_SERVICE_COMMAND_TYPE_SET.has(value)
  );
}

export type ServiceCommandRequest =
  | { kind: "protocol"; command: WsProtocolCommand }
  | {
      kind: "slash_command";
      command: "channels";
      args?: string;
      runtime: RuntimeScope;
    };

export type ServiceCommandResponse =
  | { kind: "protocol"; messages: WsProtocolMessage[] }
  | { kind: "text"; text: string };

export type ServiceEvent = {
  kind: "protocol";
  message: WsProtocolMessage;
};
