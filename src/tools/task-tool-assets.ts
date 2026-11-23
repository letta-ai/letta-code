import { getBackend } from "@/backend";
import { experimentManager } from "@/experiments/manager";
import { getRuntimeSessionSource } from "@/runtime-context";
import MonitorCloudDescription from "./descriptions/MonitorCloud.md";
import type { JsonSchema } from "./model-facing-tool";
import MonitorCloudSchema from "./schemas/MonitorCloud.json";

export function stripComputerFromTaskSchema(schema: JsonSchema): JsonSchema {
  const properties = schema.properties;
  if (!properties || !Object.hasOwn(properties, "computer")) {
    return schema;
  }
  const { computer: _computer, cloud: _cloud, ...rest } = properties;
  return { ...schema, properties: rest };
}

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
  if (
    name === "Wake" &&
    getRuntimeSessionSource() === "interactive-cli" &&
    process.env.LETTA_DESKTOP_MODE !== "1"
  ) {
    return {
      description: `${description.trimEnd()}\n\nWakes fire only while this session is running.`,
      inputSchema,
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
