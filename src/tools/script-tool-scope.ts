import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import type {
  WorkflowToolCaller,
  WorkflowToolInfo,
} from "@/tools/workflow/types";

interface ScriptScopeArgs {
  parentScope?: { agentId: string; conversationId: string };
  signal?: AbortSignal;
}

export interface ScriptToolScope {
  callTool: WorkflowToolCaller;
  builtinToolNames: string[];
  listTools(): Promise<WorkflowToolInfo[]>;
  cleanup(): Promise<void>;
}

const SCRIPT_EXCLUDED_TOOLS = new Set([
  "Agent",
  "AskUserQuestion",
  "SendAgentMessage",
  "Workflow",
  "CodeMode",
]);

function isOwningAgentId(value: string | null | undefined): value is string {
  return (
    value?.startsWith("agent-") === true && !value.startsWith("agent-free:")
  );
}

export async function resolveScriptParentAgentId(
  args: ScriptScopeArgs,
): Promise<string | null> {
  let parentAgentId: string | null | undefined = args.parentScope?.agentId;
  if (!isOwningAgentId(parentAgentId)) {
    parentAgentId = getRuntimeContext()?.agentId;
  }
  const conversationId =
    args.parentScope?.conversationId ?? getConversationId();
  if (!isOwningAgentId(parentAgentId)) {
    if (conversationId && conversationId !== "default") {
      const conversation = (await getBackend().retrieveConversation(
        conversationId,
      )) as unknown as {
        agent_id: string | null;
        parent_agent_id?: string | null;
      };
      parentAgentId =
        conversation.agent_id ?? conversation.parent_agent_id ?? null;
    } else {
      parentAgentId = getCurrentAgentId();
    }
  }
  return isOwningAgentId(parentAgentId) ? parentAgentId : null;
}

/** Capture the invoking turn's tools without creating an SDK client or workers. */
export async function createScriptToolScope(
  parentAgentId: string | null,
  signal?: AbortSignal,
): Promise<ScriptToolScope> {
  const toolContextId = getRuntimeContext()?.toolContextId ?? null;
  // Tool implementations are loaded by the manager; a static import cycles.
  const manager = await import("@/tools/manager");
  const permissionModeState = toolContextId
    ? manager.getExecutionContextPermissionModeState(toolContextId)
    : undefined;
  const permissionCwd = getCurrentWorkingDirectory();
  const builtinSchemas = [
    ...(toolContextId
      ? (manager
          .getExecutionContextById(toolContextId)
          ?.toolRegistry.values() ?? [])
      : []),
  ]
    .map((tool) => ({
      ...tool.schema,
      name: manager.getServerToolName(tool.schema.name),
    }))
    .filter((schema) => !SCRIPT_EXCLUDED_TOOLS.has(schema.name));
  const builtinToolNames = builtinSchemas.map((schema) => schema.name);
  const builtins = new Set(builtinToolNames);
  let mcpSession:
    | Promise<
        ReturnType<typeof import("@/cli/subcommands/mcp").createAgentMcpSession>
      >
    | undefined;
  const mcp = () => {
    if (!parentAgentId)
      throw new Error("MCP tools require an invoking parent agent.");
    mcpSession ??= import("@/cli/subcommands/mcp").then((module) =>
      module.createAgentMcpSession(parentAgentId),
    );
    return mcpSession;
  };
  return {
    builtinToolNames,
    listTools: async () => {
      const mcpTools = parentAgentId
        ? await (await mcp()).listTools().catch(() => [])
        : [];
      return [
        ...builtinSchemas.map((schema) => ({
          name: schema.name,
          description: schema.description,
          inputSchema: schema.input_schema as Record<string, unknown>,
        })),
        ...mcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
      ];
    },
    callTool: async (toolName, toolArgs) => {
      signal?.throwIfAborted();
      const { decision } = await manager.checkToolPermission(
        toolName,
        toolArgs,
        permissionCwd,
        permissionModeState && { ...permissionModeState },
        parentAgentId ?? undefined,
      );
      if (decision !== "allow") {
        throw new Error(
          decision === "deny"
            ? `${toolName} is denied by permission rules.`
            : `${toolName} needs approval, which a script cannot request; call it directly or add an allow rule.`,
        );
      }
      if (builtins.has(toolName)) {
        const result = await manager.executeTool(toolName, toolArgs, {
          ...(toolContextId ? { toolContextId } : {}),
          ...(signal ? { signal } : {}),
        });
        const text =
          typeof result.toolReturn === "string"
            ? result.toolReturn
            : JSON.stringify(result.toolReturn);
        return {
          content: [{ type: "text", text }],
          isError: result.status === "error",
        };
      }
      return (await mcp()).callTool(
        toolName,
        toolArgs,
        signal ? { signal } : {},
      );
    },
    cleanup: async () => {
      await mcpSession
        ?.then((session) => session.close())
        .catch(() => undefined);
    },
  };
}
