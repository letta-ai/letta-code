import { randomUUID } from "node:crypto";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { serializeClientTools } from "@/tools/client-tool-serialization";
import type {
  WorkflowToolCaller,
  WorkflowToolInfo,
  WorkflowToolResult,
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
  "AskUserQuestion",
  "Workflow",
  "CodeMode",
  // A script cannot hold a background watch's lifetime or approval.
  "Monitor",
]);

interface ServerTool extends WorkflowToolInfo {
  requiresApproval: boolean;
}

/**
 * Tools attached to the agent that Letta Cloud executes (e.g. web_search).
 * MCP tools are served by the MCP session instead, and local built-ins win
 * on a name collision, matching what the model sees in a turn.
 */
async function loadServerTools(
  agentId: string | null,
  builtins: ReadonlySet<string>,
): Promise<Map<string, ServerTool>> {
  const tools = new Map<string, ServerTool>();
  if (!agentId || !getBackend().capabilities.serverSideToolManagement) {
    return tools;
  }
  try {
    const agent = await (await getClient()).agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    // The server asks the client for approval on these instead of running them.
    const approvalRules = new Set(
      (agent.tool_rules ?? [])
        .filter((rule) => rule.type === "requires_approval")
        .map((rule) => rule.tool_name),
    );
    for (const tool of agent.tools ?? []) {
      const name = tool.name;
      if (!name || tool.tool_type === "external_mcp") continue;
      if (builtins.has(name) || SCRIPT_EXCLUDED_TOOLS.has(name)) continue;
      tools.set(name, {
        name,
        description: tool.description ?? "",
        inputSchema: (tool.json_schema?.parameters ?? {}) as Record<
          string,
          unknown
        >,
        requiresApproval:
          tool.default_requires_approval === true || approvalRules.has(name),
      });
    }
  } catch {
    // Server tools are optional; built-ins and MCP still work without them.
  }
  return tools;
}

async function callServerTool(
  agentId: string | null,
  tool: ServerTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WorkflowToolResult> {
  if (!agentId) throw new Error(`${tool.name} requires an invoking agent.`);
  if (tool.requiresApproval) {
    throw new Error(
      `${tool.name} needs approval, which a script cannot request; call it directly.`,
    );
  }
  const result = await (await getClient()).agents.tools.run(
    tool.name,
    { agent_id: agentId, args },
    signal ? { signal } : {},
  );
  const value =
    result.status === "success"
      ? result.func_return
      : (result.stderr?.join("\n") ?? result.func_return);
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value ?? null),
      },
    ],
    isError: result.status !== "success",
  };
}

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
  const context = toolContextId
    ? manager.getExecutionContextById(toolContextId)
    : undefined;
  // Use the same captured, filtered definitions sent with this turn, including
  // controller-owned tools and overrides. Never consult live registrations.
  const builtinSchemas = (
    context
      ? serializeClientTools(
          context.toolRegistry,
          context.externalTools,
          context.modTools,
          manager.getServerToolName,
        )
      : []
  ).filter((schema) => !SCRIPT_EXCLUDED_TOOLS.has(schema.name));
  const builtins = new Set(builtinSchemas.map((schema) => schema.name));
  const serverTools = await loadServerTools(parentAgentId, builtins);
  const builtinToolNames = [...builtins, ...serverTools.keys()];
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
          inputSchema: schema.parameters as Record<string, unknown>,
        })),
        ...serverTools.values(),
        ...mcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
      ];
    },
    callTool: async (toolName, toolArgs) => {
      signal?.throwIfAborted();
      const serverTool = serverTools.get(toolName);
      if (serverTool) {
        return callServerTool(parentAgentId, serverTool, toolArgs, signal);
      }
      const toolCallId = `script-${randomUUID()}`;
      const { decision } = await manager.checkToolPermission(
        toolName,
        toolArgs,
        permissionCwd,
        permissionModeState && { ...permissionModeState },
        parentAgentId ?? undefined,
        toolContextId,
        toolCallId,
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
          toolCallId,
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
