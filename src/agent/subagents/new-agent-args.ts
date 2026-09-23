import { buildSubagentLaunchTags } from "./parent-conversation";

/**
 * Subagent types that don't need server-side base tools (web_search,
 * fetch_webpage). These agents operate on local memory/git state and have
 * no use for internet access. Spawning them with `--base-tools none`
 * keeps their tool list minimal.
 *
 * fork/recall are excluded because they deploy the parent agent and
 * never trigger fresh agent creation, so base tools are out of scope.
 */
const NO_BASE_TOOL_SUBAGENT_TYPES = new Set([
  "reflection",
  "memory",
  "history-analyzer",
  "init",
]);

interface NewAgentLaunchArgsOptions {
  model?: string | null;
  systemPromptOverride?: string;
  parentAgentId?: string | null;
  parentConversationId?: string;
  runtimePlatform: NodeJS.Platform;
}

/**
 * Push the `--new-agent` launch arguments for a freshly created subagent.
 * Only used when the launch does not deploy an existing agent or
 * conversation.
 */
export function pushNewAgentLaunchArgs(
  args: string[],
  type: string,
  options: NewAgentLaunchArgsOptions,
): void {
  // A systemPromptOverride replaces the configured persona with a
  // caller-supplied prompt via `--system-custom` (mutually exclusive with
  // `--system`).
  if (options.systemPromptOverride) {
    args.push("--new-agent", "--system-custom", options.systemPromptOverride);
  } else {
    args.push("--new-agent", "--system", type);
  }
  args.push(
    "--tags",
    buildSubagentLaunchTags(
      type,
      options.parentAgentId,
      options.parentConversationId,
    ).join(","),
  );
  // Newly spawned subagents are stateless (non-memfs). The headless
  // entrypoint derives this from LETTA_CODE_AGENT_ROLE=subagent — no CLI
  // flag needed, and no user-facing opt-out exists.
  if (options.model) {
    args.push("--model", options.model);
  }

  // Reflection-specific startup flags: match the memory_reflection training
  // environment everywhere except Windows. On Windows, the startup reminder
  // identifies the native shell so the Bash-named tool's PowerShell/cmd
  // behavior does not conflict with the reflection procedure.
  if (type === "reflection") {
    if (options.runtimePlatform !== "win32") {
      args.push("--no-system-info-reminder");
    }
    args.push("--no-skills");
  }

  // Skip server-side base tools (web_search, fetch_webpage) for subagents
  // that operate purely on local memory/git state.
  if (NO_BASE_TOOL_SUBAGENT_TYPES.has(type)) {
    args.push("--base-tools", "none");
  }
}
