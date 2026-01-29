// src/mcp/server-registration.ts
// Server-aware MCP tool registration (following the design document)

import type { Tool } from "@letta-ai/letta-client/resources/tools";
import { getClient } from "../agent/client";
import { localMcpConfig } from "./local-config";
import { stdioClientManager } from "./stdio-client";

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Register stdio MCP tools with Letta Cloud as CLIENT_MCP type.
 * This follows the design document approach where the server knows about MCP tools.
 */
export async function registerMcpToolsWithServer(
  agentId: string,
  serverId: string,
  serverName: string,
  tools: McpToolSchema[],
  maxTools: number = 9, // Limit tools registered per MCP server
): Promise<{ registered: string[]; errors: Array<{ tool: string; error: string }> }> {
  const client = await getClient();
  const registered: string[] = [];
  const errors: Array<{ tool: string; error: string }> = [];

  // Limit tools to avoid quota issues
  const toolsToRegister = tools.slice(0, maxTools);
  console.error(`[mcp] Registering ${toolsToRegister.length}/${tools.length} tools (limit: ${maxTools})`);

  for (const tool of toolsToRegister) {
    try {
      // Sanitize tool name for Python function name (replace hyphens with underscores)
      const pythonName = sanitizeToolName(tool.name);

      // Generate source code (name is derived from function name in source_code)
      const sourceCode = generateMcpToolSourceCode(tool, pythonName, serverId);

      // Convert MCP schema to Letta format
      const description = tool.description
        ? `[MCP:${serverName}] ${tool.description}`
        : `MCP tool from ${serverName}`;

      // Register with Letta Cloud
      // Letta extracts name from json_schema.name (NOT from source_code parsing!)
      // See: letta/services/tool_manager.py - create_or_update_tool_async
      const createdTool = await client.tools.create({
        source_code: sourceCode,
        description: description,
        tags: ["mcp", "client-side", serverName, `mcp-server:${serverId}`],
        source_type: "python",
        // REQUIRE APPROVAL so the tool goes through the approval flow
        // This allows our CLI to intercept and execute client-side
        default_requires_approval: true,
        // IMPORTANT: json_schema MUST have 'name' at root level for Letta to use it!
        // The 'parameters' object contains the actual input schema
        json_schema: {
          name: pythonName, // <-- THIS IS THE KEY! Letta uses json_schema.name
          // Nested parameters object - this is what the agent sees
          parameters: {
            type: "object",
            properties: tool.inputSchema.properties || {},
            required: (tool.inputSchema.required as string[]) || [],
          },
          // MCP metadata (custom fields)
          "x-mcp-server": serverId,
          "x-mcp-server-name": serverName,
          "x-is-mcp": true,
          "x-mcp-original-name": tool.name, // Store original name with hyphens
        },
      });

      // Attach tool to agent
      await client.agents.tools.attach(createdTool.id, {
        agent_id: agentId,
      });

      registered.push(tool.name);
      console.error(
        `[mcp] Registered tool with server: ${tool.name} → ${pythonName} (${createdTool.id})`,
      );
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      errors.push({ tool: tool.name, error: errorMsg });
      console.error(
        `[mcp] Failed to register tool ${tool.name}: ${errorMsg}`,
      );
    }
  }

  return { registered, errors };
}

/**
 * Sanitize tool name for Python function naming.
 * Converts hyphens to underscores and ensures valid Python identifier.
 */
function sanitizeToolName(name: string): string {
  // Replace hyphens and other invalid chars with underscores
  let sanitized = name.replace(/[-]/g, "_");
  
  // Ensure starts with letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `mcp_${sanitized}`;
  }
  
  // Replace any remaining invalid characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, "_");
  
  return sanitized;
}

/**
 * Generate stub source code for MCP tool.
 * Must be minimal and parseable by Letta's Python parser.
 * The function name becomes the tool name in Letta.
 */
function generateMcpToolSourceCode(
  mcpTool: McpToolSchema,
  pythonName: string,
  _serverId: string,
): string {
  // Letta's Python parser is very strict.
  // Use the absolute simplest one-liner format that definitely works.
  // ALWAYS use **kwargs to ensure consistent parsing.
  // Single-line format avoids any indentation/newline issues.
  const desc = (mcpTool.description || "MCP tool").slice(0, 50).replace(/["\n\r]/g, " ");
  
  // Simplest valid Python function with docstring
  return `def ${pythonName}(**kwargs):\n    """${desc}"""\n    pass`;
}

/**
 * Unregister MCP tools from the server when removing a stdio server.
 */
export async function unregisterMcpToolsFromServer(
  agentId: string,
  serverId: string,
): Promise<void> {
  const client = await getClient();

  try {
    // Get all tools for the agent
    const agentTools = await client.agents.tools.list(agentId);

    // Filter tools that belong to this MCP server
    const mcpTools = agentTools.items?.filter((tool) => {
      const schema = tool.json_schema as Record<string, unknown>;
      return schema?.["x-mcp-server"] === serverId;
    });

    if (!mcpTools || mcpTools.length === 0) {
      console.error(
        `[mcp] No tools found for server ${serverId} to unregister`,
      );
      return;
    }

    // Detach and delete each tool
    for (const tool of mcpTools) {
      if (!tool.id) continue;

      try {
        // Detach from agent
        await client.agents.tools.delete(agentId, tool.id);

        // Delete the tool
        await client.tools.delete(tool.id);

        console.error(`[mcp] Unregistered tool: ${tool.name}`);
      } catch (error) {
        console.error(
          `[mcp] Failed to unregister tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[mcp] Failed to unregister tools for server ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Check if a tool is registered as an MCP tool with the server.
 */
export async function isMcpToolRegisteredWithServer(
  agentId: string,
  toolName: string,
): Promise<boolean> {
  try {
    const client = await getClient();
    const agentTools = await client.agents.tools.list(agentId);

    const tool = agentTools.items?.find((t) => t.name === toolName);
    if (!tool) return false;

    const schema = tool.json_schema as Record<string, unknown>;
    return schema?.["x-is-mcp"] === true;
  } catch {
    return false;
  }
}

/**
 * Get the MCP server ID for a registered tool.
 * Handles both original MCP names (with hyphens) and sanitized Python names.
 */
export async function getMcpServerIdForTool(
  agentId: string,
  toolName: string,
): Promise<string | null> {
  const info = await getMcpToolInfo(agentId, toolName);
  return info?.serverId ?? null;
}

/**
 * Get full MCP tool info including the original tool name.
 * This is needed because Python-safe names (get_env) differ from MCP names (get-env).
 */
export async function getMcpToolInfo(
  agentId: string,
  toolName: string,
): Promise<{ serverId: string; originalName: string } | null> {
  try {
    const client = await getClient();
    const agentTools = await client.agents.tools.list(agentId);

    // Try to find by Python name first
    let tool = agentTools.items?.find((t) => t.name === toolName);
    
    // If not found, try sanitized version
    if (!tool) {
      const sanitized = sanitizeToolName(toolName);
      tool = agentTools.items?.find((t) => t.name === sanitized);
    }
    
    // If still not found, try finding by original MCP name in schema
    if (!tool) {
      tool = agentTools.items?.find((t) => {
        const schema = t.json_schema as Record<string, unknown>;
        return schema?.["x-mcp-original-name"] === toolName;
      });
    }

    if (!tool) return null;

    const schema = tool.json_schema as Record<string, unknown>;
    const serverId = schema?.["x-mcp-server"] as string;
    // Use original name if stored, otherwise fall back to the Python name
    const originalName = (schema?.["x-mcp-original-name"] as string) || toolName;
    
    if (!serverId) return null;
    
    return { serverId, originalName };
  } catch {
    return null;
  }
}
