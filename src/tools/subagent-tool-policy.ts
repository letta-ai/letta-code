// Tool policy for agents launched through Agent. Applied when a turn's tool
// snapshot is captured, after toolsets, `tools: all`, and allowlists resolve,
// so it covers local child processes and listener-hosted subagent turns alike.

import { canLaunchSubagentsAtDepth } from "@/agent/subagents/subagent-depth";
import SendAgentMessageSubagentDescription from "./descriptions/SendAgentMessageSubagent.md";
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

/**
 * Remove Agent (internal `Task`) and Workflow at the maximum depth and give subagents the
 * SendAgentMessage description written for talking to a parent.
 */
export function applySubagentToolPolicy<T extends PolicyToolDefinition>(
  registry: Map<string, T>,
  depth: number,
): Map<string, T> {
  if (depth === 0) return registry;
  const scoped = new Map(registry);
  if (!canLaunchSubagentsAtDepth(depth)) {
    // Both tools launch subagents: Agent directly, Workflow through SDK workers.
    scoped.delete("Task");
    scoped.delete("Workflow");
  }
  const send = scoped.get("SendAgentMessage");
  if (send) {
    const description = SendAgentMessageSubagentDescription.trim();
    scoped.set("SendAgentMessage", {
      ...send,
      schema: { ...send.schema, description },
      modelForm: resolvedModelForm(
        send.modelForm,
        description,
        send.schema.input_schema,
      ),
    });
  }
  return scoped;
}
