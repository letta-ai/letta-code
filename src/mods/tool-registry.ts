import type {
  ModContext,
  ModDiagnostic,
  ModOwner,
  ModTool,
  ModToolRunContext,
  ModToolRunResult,
  ToolApprovalPolicy,
} from "@/mods/types";
import { attachDeprecatedGetContextTrap } from "./deprecated-api";
import { areModsDisabled } from "./disable";

const MOD_TOOLS_KEY = Symbol.for("@letta/modTools");

type GlobalWithModTools = typeof globalThis & {
  [MOD_TOOLS_KEY]?: Map<string, ModToolDefinition>;
};

export interface ModToolDefinition extends ModTool {
  activationSignal: AbortSignal;
  recordDiagnostic?: (
    diagnostic: Pick<
      ModDiagnostic,
      "capability" | "error" | "phase" | "severity"
    >,
  ) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getMutableModToolsRegistry(): Map<string, ModToolDefinition> {
  const global = globalThis as GlobalWithModTools;
  if (!global[MOD_TOOLS_KEY]) {
    global[MOD_TOOLS_KEY] = new Map();
  }
  return global[MOD_TOOLS_KEY];
}

export function filterAvailableModToolsRegistry(
  registry: Map<string, ModToolDefinition>,
  context?: ModContext | null,
): Map<string, ModToolDefinition> {
  if (areModsDisabled()) return new Map();

  return new Map(
    Array.from(registry.entries()).filter(([, tool]) => {
      if (tool.activationSignal.aborted) return false;
      try {
        return context
          ? (tool.isEnabled?.(
              attachDeprecatedGetContextTrap(
                { ...context },
                tool.recordDiagnostic,
                "ctx.getContext",
              ),
            ) ?? true)
          : true;
      } catch (error) {
        tool.recordDiagnostic?.({
          capability: { id: tool.name, kind: "tool" },
          error: toError(error),
          phase: "tool.isEnabled",
        });
        return false;
      }
    }),
  );
}

export function getAvailableModToolsRegistry(
  context?: ModContext | null,
): Map<string, ModToolDefinition> {
  return filterAvailableModToolsRegistry(getMutableModToolsRegistry(), context);
}

export function registerModTool(tool: ModToolDefinition): void {
  if (areModsDisabled()) return;
  getMutableModToolsRegistry().set(tool.name, tool);
}

export function unregisterModTool(name: string, owner: ModOwner): void {
  const registry = getMutableModToolsRegistry();
  const existing = registry.get(name);
  if (existing?.owner?.id === owner.id) {
    registry.delete(name);
  }
}

export function unregisterModToolsForOwner(owner: ModOwner): void {
  const registry = getMutableModToolsRegistry();
  for (const [name, tool] of registry.entries()) {
    if (tool.owner?.id === owner.id) {
      registry.delete(name);
    }
  }
}

export function clearModTools(): void {
  getMutableModToolsRegistry().clear();
}

export function getModToolDefinition(
  name: string,
  registry: Map<string, ModToolDefinition> = getMutableModToolsRegistry(),
): ModToolDefinition | undefined {
  if (areModsDisabled()) return undefined;
  return registry.get(name);
}

export function modToolRequiresApproval(
  name: string,
  registry: Map<string, ModToolDefinition> = getMutableModToolsRegistry(),
): boolean | undefined {
  if (areModsDisabled()) return undefined;
  return registry.get(name)?.requiresApproval;
}

export function modToolApprovalPolicy(
  name: string,
  registry: Map<string, ModToolDefinition> = getMutableModToolsRegistry(),
): ToolApprovalPolicy | undefined {
  if (areModsDisabled()) return undefined;
  return registry.get(name)?.approvalPolicy;
}

export function isModToolParallelSafe(
  name: string,
  registry: Map<string, ModToolDefinition> = getMutableModToolsRegistry(),
): boolean {
  if (areModsDisabled()) return false;
  return registry.get(name)?.parallelSafe === true;
}

export async function runModTool(
  tool: ModToolDefinition,
  context: ModToolRunContext,
): Promise<ModToolRunResult> {
  if (tool.activationSignal.aborted) {
    throw new Error(`Mod tool '${tool.name}' is no longer available`);
  }
  return tool.run(context);
}
