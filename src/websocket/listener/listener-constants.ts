import { getBackend } from "@/backend";

/**
 * Commands that can be dispatched by a remote client (e.g. letta-cloud desktop)
 * via the `execute_command` WebSocket message type.
 *
 * Kept in a standalone file to avoid circular imports between commands.ts
 * and protocol-outbound.ts.
 */
export const SUPPORTED_REMOTE_COMMANDS: readonly string[] = [
  "clear",
  "clear-messages",
  "doctor",
  "teleport",
  "dream",
  "reflect",
  "reflection",
  "init",
  "compact",
  "reload",
  "context-limit",
  "channels",
  "upgrade-letta-code",
  "toolset",
  // /secret opens the EditSecretsDialog and routes reads/writes through the
  // dedicated secret_list / secret_apply WS commands — not via
  // execute_command — so it has no case in handleExecuteCommand.
  "secret",
  "monitor_stop",
];

const LOCAL_REMOTE_COMMANDS = SUPPORTED_REMOTE_COMMANDS.filter(
  (command) => command !== "teleport",
);

/** Reuse backend-specific status payloads instead of allocating per routed message. */
const CACHED_REMOTE_COMMANDS = [...SUPPORTED_REMOTE_COMMANDS];
const CACHED_LOCAL_REMOTE_COMMANDS = [...LOCAL_REMOTE_COMMANDS];

export function getSupportedRemoteCommands(): string[] {
  return getBackend().capabilities.localMemfs
    ? CACHED_LOCAL_REMOTE_COMMANDS
    : CACHED_REMOTE_COMMANDS;
}
