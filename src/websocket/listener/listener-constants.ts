/**
 * Commands that can be dispatched by a remote client (e.g. letta-cloud desktop)
 * via the `execute_command` WebSocket message type.
 *
 * Kept in a standalone file to avoid circular imports between commands.ts
 * and protocol-outbound.ts.
 */
export const SUPPORTED_REMOTE_COMMANDS: readonly string[] = [
  "clear",
  "doctor",
  "init",
  "remember",
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
];
