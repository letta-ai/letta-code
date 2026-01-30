/**
 * Remote execution support via proxy tool
 *
 * When --unsafe-remote-execution is enabled, this module registers a
 * "request_local_execution" tool with the agent that allows remote callers
 * to trigger local tool execution via Letta Code's polling mechanism.
 */

import type Letta from "@letta-ai/letta-client";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import { getClient } from "./client";

// Name of the proxy tool
export const PROXY_TOOL_NAME = "request_local_execution";

// Source code for the proxy tool (stub - never actually executed server-side)
const PROXY_TOOL_SOURCE = `
def request_local_execution(tool_name: str, arguments: dict) -> str:
    """
    Request execution of a local tool on the Letta Code client.
    
    This tool is a proxy that allows remote messages to trigger local tool execution.
    The actual execution happens on the Letta Code client via polling.
    
    Args:
        tool_name: Name of the tool to execute (e.g., "Bash", "Read", "Write", "Glob", "Grep", "Edit")
        arguments: Dictionary of arguments to pass to the tool
        
    Returns:
        The result of the tool execution
    """
    # This code is never executed - Letta Code intercepts the approval request
    # and executes the tool locally
    raise NotImplementedError("This tool must be executed by Letta Code client")
`;

// JSON schema for the proxy tool
const PROXY_TOOL_SCHEMA = {
  name: PROXY_TOOL_NAME,
  description:
    "Request execution of a local tool on the Letta Code client. " +
    "Use this to run Bash commands, read/write files, search code, etc. " +
    "Available tools: Bash, Read, Write, Glob, Grep, Edit, Task, AskUserQuestion.",
  parameters: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "Name of the tool to execute (e.g., 'Bash', 'Read', 'Write', 'Glob', 'Grep', 'Edit')",
        enum: [
          "Bash",
          "Read",
          "Write",
          "Glob",
          "Grep",
          "Edit",
          "Task",
          "AskUserQuestion",
          "TodoWrite",
          "EnterPlanMode",
          "ExitPlanMode",
        ],
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool as a JSON object",
      },
    },
    required: ["tool_name", "arguments"],
  },
};

/**
 * Find the proxy tool if it already exists
 */
async function findProxyTool(client: Letta): Promise<Tool | null> {
  try {
    const tools = await client.tools.list({ name: PROXY_TOOL_NAME });
    const toolList: Tool[] = [];
    for await (const tool of tools) {
      toolList.push(tool);
    }
    return toolList.length > 0 ? (toolList[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Check if the proxy tool is attached to the agent
 */
async function isProxyToolAttached(
  client: Letta,
  agentId: string,
  toolId: string,
): Promise<boolean> {
  try {
    const agent = await client.agents.retrieve(agentId);
    // AgentState has `tools` array of Tool objects, check by ID
    return agent.tools?.some((t) => t.id === toolId) ?? false;
  } catch {
    return false;
  }
}

/**
 * Register the proxy tool with the server and attach it to the agent.
 * This enables remote messages to trigger local tool execution.
 *
 * @param agentId - The agent to attach the proxy tool to
 * @returns The tool ID if successful, null otherwise
 */
export async function registerProxyTool(
  agentId: string,
): Promise<string | null> {
  try {
    const client = await getClient();

    // Check if tool already exists
    let tool = await findProxyTool(client);

    if (!tool) {
      // Create the proxy tool
      tool = await client.tools.create({
        source_code: PROXY_TOOL_SOURCE,
        description: PROXY_TOOL_SCHEMA.description,
        json_schema: PROXY_TOOL_SCHEMA,
        default_requires_approval: true, // Always require approval
        tags: ["letta-code", "remote-execution", "proxy"],
      });
      console.error(`[remote-execution] Created proxy tool: ${tool.id}`);
    } else {
      // Tool exists - ensure requires_approval is enabled
      // This is critical: without approval, the server executes the stub directly
      if (tool.default_requires_approval !== true) {
        console.error(
          `[remote-execution] Proxy tool has requires_approval disabled, re-enabling...`,
        );
        tool = await client.tools.update(tool.id, {
          default_requires_approval: true,
        });
        console.error(
          `[remote-execution] Re-enabled requires_approval for proxy tool`,
        );
      }
    }

    // Check if already attached
    if (await isProxyToolAttached(client, agentId, tool.id)) {
      console.error(`[remote-execution] Proxy tool already attached to agent`);
      // Still ensure agent-level approval is set
      await client.agents.tools.updateApproval(PROXY_TOOL_NAME, {
        agent_id: agentId,
        body_requires_approval: true,
      });
      console.error(
        `[remote-execution] Ensured requires_approval=true at agent level`,
      );
      return tool.id;
    }

    // Attach to agent
    await client.agents.tools.attach(tool.id, { agent_id: agentId });
    console.error(
      `[remote-execution] Attached proxy tool to agent: ${agentId}`,
    );

    // Set agent-level approval requirement (this overrides the tool's default)
    await client.agents.tools.updateApproval(PROXY_TOOL_NAME, {
      agent_id: agentId,
      body_requires_approval: true,
    });
    console.error(
      `[remote-execution] Set requires_approval=true at agent level`,
    );

    return tool.id;
  } catch (error) {
    console.error(
      `[remote-execution] Failed to register proxy tool:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Detach the proxy tool from an agent (cleanup)
 */
export async function detachProxyTool(agentId: string): Promise<void> {
  try {
    const client = await getClient();
    const tool = await findProxyTool(client);

    if (tool && (await isProxyToolAttached(client, agentId, tool.id))) {
      await client.agents.tools.detach(tool.id, { agent_id: agentId });
      console.error(`[remote-execution] Detached proxy tool from agent`);
    }
  } catch (error) {
    console.error(
      `[remote-execution] Failed to detach proxy tool:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Check if an approval request is for the proxy tool
 */
export function isProxyToolApproval(toolName: string): boolean {
  return toolName === PROXY_TOOL_NAME;
}

/**
 * Parse proxy tool arguments to extract the actual tool call
 */
export function parseProxyToolArgs(argsJson: string): {
  toolName: string;
  arguments: Record<string, unknown>;
} | null {
  try {
    const args = JSON.parse(argsJson);
    if (
      typeof args.tool_name === "string" &&
      typeof args.arguments === "object"
    ) {
      return {
        toolName: args.tool_name,
        arguments: args.arguments,
      };
    }
    return null;
  } catch {
    return null;
  }
}
