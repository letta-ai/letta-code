import { isSkillSourceArray } from "@/agent/skill-sources";
import { isRuntimeExecutionSettings } from "@/runtime-execution-settings";
import type { RuntimeStartCommand } from "@/types/runtime-start-protocol";
import { isRuntimeStartExternalToolsGroup } from "./external-tool-protocol";
import { isObjectRecord, isStringArray } from "./protocol-validation";

function isDevicePermissionMode(value: unknown): boolean {
  return (
    value === "standard" ||
    value === "acceptEdits" ||
    value === "unrestricted" ||
    value === "strict"
  );
}

export function isRuntimeStartCommand(
  value: unknown,
): value is RuntimeStartCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    c.type === "runtime_start" &&
    typeof c.request_id === "string" &&
    (c.agent_id === undefined || typeof c.agent_id === "string") &&
    (c.create_agent === undefined ||
      isRuntimeStartCreateAgentOptions(c.create_agent)) &&
    (c.conversation_id === undefined ||
      typeof c.conversation_id === "string") &&
    (c.create_conversation === undefined ||
      isRuntimeStartCreateConversationOptions(c.create_conversation)) &&
    (c.conversation_source_tags === undefined ||
      isStringArray(c.conversation_source_tags)) &&
    (c.cwd === undefined || c.cwd === null || typeof c.cwd === "string") &&
    (c.mode === undefined || isDevicePermissionMode(c.mode)) &&
    (c.execution_settings === undefined ||
      isRuntimeExecutionSettings(c.execution_settings)) &&
    (c.workspace_sandbox === undefined ||
      isRuntimeStartWorkspaceSandbox(c.workspace_sandbox)) &&
    (c.skill_sources === undefined || isSkillSourceArray(c.skill_sources)) &&
    (c.preserve_skill_sources === undefined ||
      typeof c.preserve_skill_sources === "boolean") &&
    (c.client_info === undefined || isRuntimeStartClientInfo(c.client_info)) &&
    (c.recover_approvals === undefined ||
      typeof c.recover_approvals === "boolean") &&
    (c.force_device_status === undefined ||
      typeof c.force_device_status === "boolean") &&
    (c.wait_for_replay === undefined ||
      typeof c.wait_for_replay === "boolean") &&
    (c.external_tools === undefined ||
      (Array.isArray(c.external_tools) &&
        c.external_tools.every(isRuntimeStartExternalToolsGroup)))
  );
}

export function isRuntimeStartCreateAgentOptions(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    isObjectRecord(value.body) &&
    (value.pin_global === undefined || typeof value.pin_global === "boolean") &&
    (value.memfs === undefined || typeof value.memfs === "boolean")
  );
}

export function isRuntimeStartCreateConversationOptions(
  value: unknown,
): boolean {
  if (!isObjectRecord(value)) return false;
  return value.body === undefined || isObjectRecord(value.body);
}

export function isRuntimeStartClientInfo(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.version === undefined || typeof value.version === "string")
  );
}

export function isRuntimeStartWorkspaceSandbox(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.root === "string" && typeof value.isolation_root === "string"
  );
}
