import { debugLog } from "@/utils/debug";
import {
  type ModelFacingToolForm,
  serializeFunctionOnlyToolPayload,
} from "./model-facing-tool";

interface ClientToolShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface BuiltInToolShape {
  modelForm: ModelFacingToolForm;
}

interface NamedToolShape extends ClientToolShape {}

export function serializeClientTools(
  registry: ReadonlyMap<string, BuiltInToolShape>,
  externalTools: ReadonlyMap<string, NamedToolShape>,
  modTools: ReadonlyMap<string, NamedToolShape>,
  getServerToolName: (name: string) => string,
): ClientToolShape[] {
  const builtInTools = Array.from(registry.entries())
    .filter(([name]) => !externalTools.has(name) && !modTools.has(name))
    .map(([name, tool]) =>
      serializeFunctionOnlyToolPayload(getServerToolName(name), tool.modelForm),
    );
  for (const name of externalTools.keys()) {
    if (modTools.has(name)) {
      debugLog(
        "tools",
        "mod tool %s shadows external tool with same name",
        name,
      );
    }
  }
  const externalClientTools = Array.from(externalTools.values()).filter(
    (tool) => !modTools.has(tool.name),
  );
  return [...builtInTools, ...externalClientTools, ...modTools.values()].map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
  );
}
