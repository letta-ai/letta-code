import { settingsManager } from "@/settings-manager";
import type { ClientPreferences } from "@/types/client-preferences";
import { isRecord } from "@/utils/type-guards";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";
import { getInternalToolName, getServerToolName } from "./tool-name-mapping";

export function normalizeClientPreferences(value: unknown): ClientPreferences {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "toolset")) {
    throw new Error(
      "client_preferences must be an object containing only an optional toolset",
    );
  }
  if (!Object.hasOwn(value, "toolset")) return {};
  const toolset = value.toolset;
  if (
    !isRecord(toolset) ||
    Object.keys(toolset).some((key) => key !== "include") ||
    !Array.isArray(toolset.include) ||
    !toolset.include.every((name) => typeof name === "string")
  ) {
    throw new Error(
      "client_preferences.toolset must contain include: string[]",
    );
  }
  const include = [
    ...new Set(
      toolset.include.map((name: string) => {
        const internalName = getInternalToolName(name);
        if (!Object.hasOwn(TOOL_DEFINITIONS, internalName))
          throw new Error(`Unknown bundled client tool: ${name}`);
        return getServerToolName(internalName as ToolName);
      }),
    ),
  ].sort();
  return include.length ? { toolset: { include } } : {};
}

export function isClientPreferences(
  value: unknown,
): value is ClientPreferences {
  try {
    normalizeClientPreferences(value);
    return true;
  } catch {
    return false;
  }
}

export function getStoredClientPreferences(
  agentId: string | null,
  conversationId?: string | null,
): ClientPreferences {
  try {
    return settingsManager.getClientPreferences(
      agentId ?? (conversationId || "default"),
      conversationId || "default",
    );
  } catch {
    return {};
  }
}

export function replaceClientPreferences(
  agentId: string | null,
  conversationId: string | null | undefined,
  preferences: ClientPreferences,
): void {
  settingsManager.setClientPreferences(
    agentId ?? (conversationId || "default"),
    conversationId || "default",
    normalizeClientPreferences(preferences),
  );
}
