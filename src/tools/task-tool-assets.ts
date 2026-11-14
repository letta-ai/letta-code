import { getBackend } from "@/backend";
import { experimentManager } from "@/experiments/manager";
import MonitorCloudDescription from "./descriptions/MonitorCloud.md";
import type { JsonSchema } from "./model-facing-tool";
import MonitorCloudSchema from "./schemas/MonitorCloud.json";

/**
 * Remove the `computer` parameter from the Task tool schema. Used when the
 * backend has no environment routing (local backend, self-hosted or remote
 * app server): the computers concept only exists on Letta Cloud, so the
 * option should not be advertised to the model at all.
 */
export function stripComputerFromTaskSchema(schema: JsonSchema): JsonSchema {
  const properties = schema.properties;
  if (!properties || !Object.hasOwn(properties, "computer")) {
    return schema;
  }
  const { computer: _computer, ...rest } = properties;
  return { ...schema, properties: rest };
}

/**
 * Adjust a bundled tool's model-facing assets for the active backend. Monitor selects Cloud assets when its experiment is enabled.
 * Task varies by backend: it advertises `computer` only when the backend can route
 * work to another environment.
 */
export async function resolveBackendSpecificToolAssets(
  name: string,
  description: string,
  inputSchema: JsonSchema,
): Promise<{ description: string; inputSchema: JsonSchema }> {
  if (name === "Monitor" && experimentManager.isEnabled("cloud_monitors")) {
    return {
      description: (MonitorCloudDescription as string).trim(),
      inputSchema: MonitorCloudSchema as JsonSchema,
    };
  }
  if (name !== "Task") {
    return { description, inputSchema };
  }
  let environmentRouting = false;
  try {
    environmentRouting = getBackend().capabilities.environmentRouting;
  } catch {
    environmentRouting = false;
  }
  if (environmentRouting) {
    return { description, inputSchema };
  }
  return {
    description,
    inputSchema: stripComputerFromTaskSchema(inputSchema),
  };
}
