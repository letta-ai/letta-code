import type { LaunchSubagentCommand } from "@/types/subagent-protocol";
import { isAgentRuntimeScope } from "./protocol-validation";

const ARGUMENTS = new Set([
  "subagent_type",
  "prompt",
  "description",
  "model",
  "reasoning_effort",
  "agent_id",
  "conversation_id",
  "client_message_id",
  "computer",
  "max_turns",
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
    "reasoning_effort",
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
  return (
    args.max_turns === undefined ||
    (typeof args.max_turns === "number" &&
      Number.isSafeInteger(args.max_turns) &&
      args.max_turns > 0)
  );
}
