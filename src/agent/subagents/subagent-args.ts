/**
 * Command-line arguments for spawning a subagent process
 */

import { platform } from "node:os";
import type { ModelReasoningEffort } from "@/agent/model";
import type { BackendMode } from "@/backend";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { sessionPermissions } from "@/permissions/session";
import type { SubagentConfig } from ".";
import { buildSubagentPrompt } from "./context-budget";

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

interface BuildSubagentArgsOptions {
  backendMode?: BackendMode;
  promptTransport?: "argv" | "stdin";
  /** Runtime platform override for launcher tests. */
  platform?: NodeJS.Platform;
  extraTools?: string[];
  parentAgentId?: string | null;
  /**
   * Replace the subagent's configured persona: pass `--system-custom <text>`
   * to the child instead of `--system <type>`. Only applies to new agents.
   */
  systemPromptOverride?: string;
  /**
   * Route the child's turn to a connected computer (`--computer`).
   * The child resolves the selector and fails fast if the device is offline,
   * ambiguous, or does not support environment-routed messaging.
   */
  environment?: string;
  /** Identity for the child's initial assignment, never inherited. */
  clientMessageId?: string;
  /**
   * Reasoning effort for the child's model (`--reasoning-effort`), applied on
   * top of the effort implied by the model ID. Only applies to new agents;
   * a deployed existing agent keeps its own model settings.
   */
  reasoningEffort?: ModelReasoningEffort;
}

/** Build CLI arguments for spawning a subagent. */
export function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  options: BuildSubagentArgsOptions = {},
): string[] {
  const args: string[] = [];
  const runtimePlatform = options.platform ?? platform();
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  if (options.backendMode) {
    args.push("--backend", options.backendMode);
  }

  if (options.clientMessageId !== undefined)
    args.push("--client-message-id", options.clientMessageId);

  if (options.environment) {
    // The child only submits the send and exits with the enqueue receipt;
    // this process follows the remote turn through Cloud's status APIs
    // (see remote-turn-wait.ts). No child process waits on the remote turn.
    args.push("--computer", options.environment, "--no-wait");
  }

  if (isDeployingExisting) {
    // Deploy existing agent/conversation
    if (existingConversationId) {
      // "default" is agent-scoped; conv-* IDs identify their owner directly.
      if (existingConversationId === "default" && existingAgentId) {
        args.push("--agent", existingAgentId);
      }
      args.push("--conv", existingConversationId);
    } else if (existingAgentId) {
      // agent_id only - use --new to create a new conversation for thread safety
      // (multiple parallel calls to the same agent need separate conversations)
      args.push("--agent", existingAgentId, "--new");
    }
    // Don't pass --system (existing agent keeps its prompt)
    // Don't pass --model (existing agent keeps its model)
  } else {
    // Create new agent (original behavior). A systemPromptOverride replaces the
    // configured persona with a caller-supplied prompt via `--system-custom`
    // (mutually exclusive with `--system`).
    if (options.systemPromptOverride) {
      args.push("--new-agent", "--system-custom", options.systemPromptOverride);
    } else {
      args.push("--new-agent", "--system", type);
    }
    const subagentTags = [`type:${type}`];
    if (options.parentAgentId) {
      subagentTags.push(`parent:${options.parentAgentId}`);
    }
    args.push("--tags", subagentTags.join(","));
    // Newly spawned subagents are stateless (non-memfs). The headless
    // entrypoint derives this from LETTA_CODE_AGENT_ROLE=subagent — no CLI
    // flag needed, and no user-facing opt-out exists.
    if (model) {
      args.push("--model", model);
    }

    // Pushed independently of --model so "same model, more effort" works.
    if (options.reasoningEffort) {
      args.push("--reasoning-effort", options.reasoningEffort);
    }

    // Reflection-specific startup flags: match the memory_reflection training
    // environment everywhere except Windows. On Windows, the startup reminder
    // identifies the native shell so the Bash-named tool's PowerShell/cmd
    // behavior does not conflict with the reflection procedure.
    if (type === "reflection") {
      if (runtimePlatform !== "win32") {
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

  if (options.promptTransport !== "stdin") {
    args.push("-p", buildSubagentPrompt(type, config, userPrompt));
  }
  args.push("--output-format", "stream-json");
  args.push("--permission-mode", "unrestricted");

  // Build list of auto-approved tools:
  // 1. Inherit from parent (CLI + session rules)
  // 2. Add subagent's allowed tools (so they don't hang on approvals)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const subagentTools =
    config.allowedTools !== "all" && Array.isArray(config.allowedTools)
      ? config.allowedTools
      : [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules, ...subagentTools]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }

  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  // Add tool filtering if specified (applies to both new and existing agents)
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    const scopedTools = Array.from(
      new Set([...(config.allowedTools ?? []), ...(options.extraTools ?? [])]),
    );
    args.push("--tools", scopedTools.join(","));
  }

  // Add max turns limit if specified
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  // Pre-load skills specified in the subagent config
  if (config.skills.length > 0) {
    args.push("--pre-load-skills", config.skills.join(","));
  }

  return args;
}
