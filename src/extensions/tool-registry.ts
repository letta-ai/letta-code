import type {
  ExtensionOwner,
  ExtensionTool,
  ExtensionToolRunContext,
  ExtensionToolRunResult,
} from "@/extensions/types";

const EXTENSION_TOOLS_KEY = Symbol.for("@letta/extensionTools");

type GlobalWithExtensionTools = typeof globalThis & {
  [EXTENSION_TOOLS_KEY]?: Map<string, ExtensionToolDefinition>;
};

export interface ExtensionToolDefinition extends ExtensionTool {
  activationSignal: AbortSignal;
  getContext: ExtensionToolRunContext["getContext"];
  isAvailable: () => boolean;
}

function getMutableExtensionToolsRegistry(): Map<
  string,
  ExtensionToolDefinition
> {
  const global = globalThis as GlobalWithExtensionTools;
  if (!global[EXTENSION_TOOLS_KEY]) {
    global[EXTENSION_TOOLS_KEY] = new Map();
  }
  return global[EXTENSION_TOOLS_KEY];
}

export function getAvailableExtensionToolsRegistry(): Map<
  string,
  ExtensionToolDefinition
> {
  return new Map(
    Array.from(getMutableExtensionToolsRegistry().entries()).filter(
      ([, tool]) => {
        if (tool.activationSignal.aborted) return false;
        try {
          return tool.isAvailable();
        } catch {
          return false;
        }
      },
    ),
  );
}

export function registerExtensionTool(tool: ExtensionToolDefinition): void {
  getMutableExtensionToolsRegistry().set(tool.name, tool);
}

export function unregisterExtensionTool(
  name: string,
  owner: ExtensionOwner,
): void {
  const registry = getMutableExtensionToolsRegistry();
  const existing = registry.get(name);
  if (existing?.owner?.id === owner.id) {
    registry.delete(name);
  }
}

export function unregisterExtensionToolsForOwner(owner: ExtensionOwner): void {
  const registry = getMutableExtensionToolsRegistry();
  for (const [name, tool] of registry.entries()) {
    if (tool.owner?.id === owner.id) {
      registry.delete(name);
    }
  }
}

export function clearExtensionTools(): void {
  getMutableExtensionToolsRegistry().clear();
}

export function getExtensionToolDefinition(
  name: string,
  registry: Map<
    string,
    ExtensionToolDefinition
  > = getMutableExtensionToolsRegistry(),
): ExtensionToolDefinition | undefined {
  return registry.get(name);
}

export function extensionToolRequiresApproval(
  name: string,
  registry: Map<
    string,
    ExtensionToolDefinition
  > = getMutableExtensionToolsRegistry(),
): boolean | undefined {
  return registry.get(name)?.requiresApproval;
}

export function isExtensionToolParallelSafe(
  name: string,
  registry: Map<
    string,
    ExtensionToolDefinition
  > = getMutableExtensionToolsRegistry(),
): boolean {
  return registry.get(name)?.parallelSafe === true;
}

export async function runExtensionTool(
  tool: ExtensionToolDefinition,
  context: ExtensionToolRunContext,
): Promise<ExtensionToolRunResult> {
  if (tool.activationSignal.aborted) {
    throw new Error(`Extension tool '${tool.name}' is no longer available`);
  }
  return tool.run(context);
}
