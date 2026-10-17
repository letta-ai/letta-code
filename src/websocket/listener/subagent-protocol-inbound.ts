import type {
  LaunchSubagentCommand,
  SubagentMessageCommand,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import { isAgentRuntimeScope } from "./protocol-validation";

const ARGUMENTS = new Set([
  "subagent_type",
  "prompt",
  "description",
  "model",
  "agent_id",
  "conversation_id",
  "client_message_id",
  "computer",
  "max_turns",
  "mcp",
]);

export function isLaunchSubagentCommand(
  value: unknown,
): value is LaunchSubagentCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<LaunchSubagentCommand>;
  if (
    c.type !== "launch_subagent" ||
    typeof c.request_id !== "string" ||
    !c.request_id.trim() ||
    !isAgentRuntimeScope(c.runtime) ||
    !c.runtime.agent_id.trim() ||
    !c.runtime.conversation_id.trim() ||
    (c.runtime.acting_user_id !== undefined &&
      typeof c.runtime.acting_user_id !== "string") ||
    (c.tool_call_id !== undefined &&
      (typeof c.tool_call_id !== "string" || !c.tool_call_id.trim())) ||
    (c.notify !== undefined && c.notify !== "caller") ||
    !c.args ||
    typeof c.args !== "object" ||
    Array.isArray(c.args)
  )
    return false;
  const args = c.args as unknown as Record<string, unknown>;
  if (Object.keys(args).some((key) => !ARGUMENTS.has(key))) return false;
  if (
    typeof args.prompt !== "string" ||
    !args.prompt.trim() ||
    typeof args.description !== "string" ||
    !args.description.trim()
  )
    return false;
  for (const key of [
    "subagent_type",
    "model",
    "agent_id",
    "conversation_id",
    "client_message_id",
    "computer",
  ]) {
    if (
      args[key] !== undefined &&
      (typeof args[key] !== "string" || !(args[key] as string).trim())
    )
      return false;
  }
  // launchSubagent validates the MCP selection's contents.
  if (
    args.mcp !== undefined &&
    (!args.mcp || typeof args.mcp !== "object" || Array.isArray(args.mcp))
  )
    return false;
  return (
    args.max_turns === undefined ||
    (typeof args.max_turns === "number" &&
      Number.isSafeInteger(args.max_turns) &&
      args.max_turns > 0)
  );
}

function hasValidControlBase(value: unknown): value is Record<
  string,
  unknown
> & {
  request_id: string;
  runtime: SubagentMessageCommand["runtime"];
  agent_id: string;
} {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.request_id === "string" &&
    c.request_id.trim().length > 0 &&
    isAgentRuntimeScope(c.runtime) &&
    c.runtime.agent_id.trim().length > 0 &&
    c.runtime.conversation_id.trim().length > 0 &&
    typeof c.agent_id === "string" &&
    c.agent_id.trim().length > 0
  );
}

export function isSubagentMessageCommand(
  value: unknown,
): value is SubagentMessageCommand {
  if (!hasValidControlBase(value) || value.type !== "subagent_message")
    return false;
  return (
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    (value.tool_call_id === undefined ||
      (typeof value.tool_call_id === "string" &&
        value.tool_call_id.trim().length > 0))
  );
}

export function isSubagentStopCommand(
  value: unknown,
): value is SubagentStopCommand {
  return hasValidControlBase(value) && value.type === "subagent_stop";
}
