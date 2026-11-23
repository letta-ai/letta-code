import { canLaunchSubagentsAtDepth } from "@/agent/subagents/subagent-depth";
import {
  functionToolForm,
  type JsonSchema,
  type ModelFacingToolForm,
} from "./model-facing-tool";

interface PolicyToolDefinition {
  schema: { name: string; description: string; input_schema: JsonSchema };
  modelForm: ModelFacingToolForm;
}

export function resolvedModelForm(
  base: ModelFacingToolForm,
  description: string,
  inputSchema: JsonSchema,
): ModelFacingToolForm {
  if (base.type === "custom") {
    return {
      ...base,
      functionFallback: {
        ...base.functionFallback,
        description,
        parameters: inputSchema,
      },
    };
  }

  return functionToolForm({
    description,
    parameters: inputSchema,
  });
}

export function applySubagentToolPolicy<T extends PolicyToolDefinition>(
  registry: Map<string, T>,
  depth: number,
): Map<string, T> {
  if (depth === 0) return registry;
  const scoped = new Map(registry);
  if (!canLaunchSubagentsAtDepth(depth)) scoped.delete("Task");
  return scoped;
}
