/** Public app-server websocket protocol export. */
import type { WsProtocolCommand, WsProtocolMessage } from "./protocol_v2";
import type {
  SubagentMessageCommand,
  SubagentMessageResponse,
  SubagentStopCommand,
  SubagentStopResponse,
} from "./subagent-protocol";

export * from "./app-server-info";
export * from "./conversation-fork-protocol";
export * from "./protocol_v2";
export * from "./queue-update-protocol";

export type AppServerProtocolCommand =
  | WsProtocolCommand
  | SubagentMessageCommand
  | SubagentStopCommand;

export type AppServerProtocolMessage =
  | WsProtocolMessage
  | SubagentMessageResponse
  | SubagentStopResponse;
