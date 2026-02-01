import type {
  SseMcpServer,
  StdioMcpServer,
  StreamableHTTPMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import { Box, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface McpSelectorProps {
  agentId: string;
  onAdd: () => void;
  onCancel: () => void;
}

type McpServer = StreamableHTTPMcpServer | SseMcpServer | StdioMcpServer;

const DISPLAY_PAGE_SIZE = 5;
const TOOLS_DISPLAY_PAGE_SIZE = 8;

/**
 * Get a display string for the MCP server type
 */
function getServerTypeDisplay(server: McpServer): string {
  switch (server.mcp_server_type) {
    case "streamable_http":
      return "HTTP";
    case "sse":
      return "SSE";
    case "stdio":
      return "stdio";
    default:
      return "unknown";
  }
}

/**
 * Get the server URL or command for display
 */
function getServerTarget(server: McpServer): string {
  if ("server_url" in server) {
    return server.server_url;
  }
  if ("command" in server) {
    return `${server.command} ${server.args.join(" ")}`;
  }
  return "unknown";
}

/**
 * Truncate text with ellipsis if it exceeds width
 */
function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth < 10) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

type Mode = "browsing" | "confirming-delete" | "viewing-tools";

export const McpSelector = memo(function McpSelector({
  agentId,
  onAdd,
  onCancel,
}: McpSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [mode, setMode] = useState<Mode>("browsing");
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Tools viewing state
  const [viewingServer, setViewingServer] = useState<McpServer | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [attachedToolIds, setAttachedToolIds] = useState<Set<string>>(
    new Set(),
  );
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsPage, setToolsPage] = useState(0);
  const [toolsSelectedIndex, setToolsSelectedIndex] = useState(0);
  const [isTogglingTool, setIsTogglingTool] = useState(false);

  // Load MCP servers
  const loadServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await getClient();
      const serverList = await client.mcpServers.list();
      setServers(serverList);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load MCP servers",
      );
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAttachedToolIds = useCallback(
    async (client: Awaited<ReturnType<typeof getClient>>) => {
      // Use dedicated tools endpoint instead of fetching whole agent
      // Pass limit to avoid pagination issues
      const toolsPage = await client.agents.tools.list(agentId, { limit: 50 });
      return new Set(toolsPage.items?.map((t) => t.id) || []);
    },
    [agentId],
  );

  // Load tools for a specific server
  const loadTools = useCallback(
    async (server: McpServer) => {
      if (!server.id) {
        setToolsError("Server ID not available");
        return;
      }

      setToolsLoading(true);
      setToolsError(null);
      setViewingServer(server);
      setMode("viewing-tools");

      try {
        const client = await getClient();

        // Fetch MCP server tools
        const toolsList = await client.mcpServers.tools.list(server.id);

        // If no tools found, might need to refresh from server
        if (toolsList.length === 0) {
          setToolsError(
            "No tools found. The server may need to be refreshed. Press R to sync tools from the MCP server.",
          );
        }

        setTools(toolsList);

        // Fetch agent's current tools to check which are attached
        const agentToolIds = await fetchAttachedToolIds(client);
        setAttachedToolIds(agentToolIds);

        setToolsPage(0);
        setToolsSelectedIndex(0);
      } catch (err) {
        setToolsError(
          err instanceof Error ? err.message : "Failed to load tools",
        );
        setTools([]);
      } finally {
        setToolsLoading(false);
      }
    },
    [fetchAttachedToolIds],
  );

  // Refresh tools from MCP server
  const refreshToolsFromServer = useCallback(async () => {
    if (!viewingServer?.id) return;

    setToolsLoading(true);
    setToolsError(null);

    try {
      const client = await getClient();

      // Call refresh endpoint to sync tools from the MCP server
      await client.mcpServers.refresh(viewingServer.id, { agent_id: agentId });

      // Reload tools list
      const toolsList = await client.mcpServers.tools.list(viewingServer.id);
      setTools(toolsList);

      // Refresh agent's current tools
      const agentToolIds = await fetchAttachedToolIds(client);
      setAttachedToolIds(agentToolIds);

      setToolsPage(0);
      setToolsSelectedIndex(0);

      // Clear error if successful
      if (toolsList.length === 0) {
        setToolsError("Server refreshed but no tools available.");
      }
    } catch (err) {
      setToolsError(
        err instanceof Error
          ? `Failed to refresh: ${err.message}`
          : "Failed to refresh tools",
      );
    } finally {
      setToolsLoading(false);
    }
  }, [agentId, fetchAttachedToolIds, viewingServer]);

  // Toggle tool attachment
  const toggleTool = useCallback(
    async (tool: Tool) => {
      setIsTogglingTool(true);
      try {
        const client = await getClient();
        const isAttached = attachedToolIds.has(tool.id);

        if (isAttached) {
          // Detach tool
          await client.agents.tools.detach(tool.id, { agent_id: agentId });
        } else {
          // Attach tool
          await client.agents.tools.attach(tool.id, { agent_id: agentId });
        }

        // Fetch agent's current tools to get accurate total count
        const agentToolIds = await fetchAttachedToolIds(client);
        setAttachedToolIds(agentToolIds);
      } catch (err) {
        setToolsError(
          err instanceof Error
            ? err.message
            : "Failed to toggle tool attachment",
        );
      } finally {
        setIsTogglingTool(false);
      }
    },
    [agentId, attachedToolIds, fetchAttachedToolIds],
  );

  // Attach all tools
  const attachAllTools = useCallback(async () => {
    setIsTogglingTool(true);
    try {
      const client = await getClient();

      // Attach tools that aren't already attached
      const unattachedTools = tools.filter((t) => !attachedToolIds.has(t.id));
      await Promise.all(
        unattachedTools.map((tool) =>
          client.agents.tools.attach(tool.id, { agent_id: agentId }),
        ),
      );

      // Fetch agent's current tools to get accurate total count
      const agentToolIds = await fetchAttachedToolIds(client);
      setAttachedToolIds(agentToolIds);
    } catch (err) {
      setToolsError(
        err instanceof Error ? err.message : "Failed to attach all tools",
      );
    } finally {
      setIsTogglingTool(false);
    }
  }, [agentId, tools, attachedToolIds, fetchAttachedToolIds]);

  // Detach all tools
  const detachAllTools = useCallback(async () => {
    setIsTogglingTool(true);
    try {
      const client = await getClient();

      // Detach only the tools from this server that are currently attached
      const attachedTools = tools.filter((t) => attachedToolIds.has(t.id));
      await Promise.all(
        attachedTools.map((tool) =>
          client.agents.tools.detach(tool.id, { agent_id: agentId }),
        ),
      );

      // Fetch agent's current tools to get accurate total count
      const agentToolIds = await fetchAttachedToolIds(client);
      setAttachedToolIds(agentToolIds);
    } catch (err) {
      setToolsError(
        err instanceof Error ? err.message : "Failed to detach all tools",
      );
    } finally {
      setIsTogglingTool(false);
    }
  }, [agentId, tools, attachedToolIds, fetchAttachedToolIds]);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  // Pagination
  const totalPages = Math.ceil(servers.length / DISPLAY_PAGE_SIZE);
  const startIndex = currentPage * DISPLAY_PAGE_SIZE;
  const pageServers = servers.slice(startIndex, startIndex + DISPLAY_PAGE_SIZE);

  // Get currently selected server
  const selectedServer = pageServers[selectedIndex];

  useInput((input, key) => {
    // CTRL-C: immediately cancel (works even during loading)
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (loading) return;

    // Handle delete confirmation mode
    if (mode === "confirming-delete") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((prev) => (prev === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0 && selectedServer) {
          // Yes - delete server
          (async () => {
            try {
              const client = await getClient();
              if (selectedServer.id) {
                await client.mcpServers.delete(selectedServer.id);
                await loadServers();
                // Reset selection if needed
                if (pageServers.length === 1 && currentPage > 0) {
                  setCurrentPage((prev) => prev - 1);
                }
                setSelectedIndex(0);
              }
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Failed to delete MCP server",
              );
            }
            setMode("browsing");
          })();
        } else {
          // No - cancel
          setMode("browsing");
        }
      } else if (key.escape) {
        setMode("browsing");
      }
      return;
    }

    // Handle viewing tools mode
    if (mode === "viewing-tools") {
      if (isTogglingTool) return; // Prevent input during toggle

      const toolsTotalPages = Math.ceil(tools.length / TOOLS_DISPLAY_PAGE_SIZE);
      const toolsStartIndex = toolsPage * TOOLS_DISPLAY_PAGE_SIZE;
      const pageTools = tools.slice(
        toolsStartIndex,
        toolsStartIndex + TOOLS_DISPLAY_PAGE_SIZE,
      );
      const selectedTool = pageTools[toolsSelectedIndex];

      if (key.upArrow) {
        if (toolsSelectedIndex === 0 && toolsPage > 0) {
          // At top of page, go to previous page
          setToolsPage((prev) => prev - 1);
          setToolsSelectedIndex(TOOLS_DISPLAY_PAGE_SIZE - 1);
        } else {
          setToolsSelectedIndex((prev) => Math.max(0, prev - 1));
        }
      } else if (key.downArrow) {
        if (
          toolsSelectedIndex === pageTools.length - 1 &&
          toolsPage < toolsTotalPages - 1
        ) {
          // At bottom of page, go to next page
          setToolsPage((prev) => prev + 1);
          setToolsSelectedIndex(0);
        } else {
          setToolsSelectedIndex((prev) =>
            Math.min(pageTools.length - 1, prev + 1),
          );
        }
      } else if ((key.return || input === " ") && selectedTool) {
        // Space or Enter to toggle selected tool
        toggleTool(selectedTool);
      } else if (input === "a" || input === "A") {
        // Attach all tools
        attachAllTools();
      } else if (input === "d" || input === "D") {
        // Detach all tools
        detachAllTools();
      } else if (input === "r" || input === "R") {
        // Refresh tools from MCP server
        refreshToolsFromServer();
      } else if (key.escape) {
        // Go back to server list
        setMode("browsing");
        setViewingServer(null);
        setTools([]);
        setToolsError(null);
      }
      return;
    }

    // Browsing mode
    if (key.upArrow) {
      if (selectedIndex === 0 && currentPage > 0) {
        // At top of page, go to previous page
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(DISPLAY_PAGE_SIZE - 1);
      } else {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      }
    } else if (key.downArrow) {
      if (
        selectedIndex === pageServers.length - 1 &&
        currentPage < totalPages - 1
      ) {
        // At bottom of page, go to next page
        setCurrentPage((prev) => prev + 1);
        setSelectedIndex(0);
      } else {
        setSelectedIndex((prev) => Math.min(pageServers.length - 1, prev + 1));
      }
    } else if (key.return) {
      // Enter to view tools for selected server
      if (selectedServer) {
        loadTools(selectedServer);
      }
    } else if (input === "a" || input === "A") {
      // 'a' to add new server
      onAdd();
    } else if (key.escape) {
      onCancel();
    } else if (input === "d" || input === "D") {
      if (selectedServer) {
        setMode("confirming-delete");
        setDeleteConfirmIndex(1); // Default to "No"
      }
    } else if (input === "r" || input === "R") {
      // Refresh server list
      loadServers();
    }
  });

  // Tools viewing UI
  if (mode === "viewing-tools" && viewingServer) {
    const toolsTotalPages = Math.ceil(tools.length / TOOLS_DISPLAY_PAGE_SIZE);
    const toolsStartIndex = toolsPage * TOOLS_DISPLAY_PAGE_SIZE;
    const pageTools = tools.slice(
      toolsStartIndex,
      toolsStartIndex + TOOLS_DISPLAY_PAGE_SIZE,
    );

    return (
      <Box flexDirection="column">
        {/* Command header */}
        <Text dimColor>{"> /mcp"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        {/* Title */}
        <Box marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Tools for {viewingServer.server_name}
          </Text>
        </Box>

        {/* Loading state */}
        {toolsLoading && (
          <Box flexDirection="column">
            <Text dimColor>
              {"  "}
              {tools.length > 0 ? "Refreshing tools..." : "Loading tools..."}
            </Text>
            {tools.length === 0 && (
              <Text dimColor>{"  "}This may take a moment on first load</Text>
            )}
          </Box>
        )}

        {/* Error state */}
        {!toolsLoading && toolsError && (
          <Box flexDirection="column">
            <Text color="yellow">
              {"  "}
              {toolsError}
            </Text>
            <Box marginTop={1}>
              <Text dimColor>{"  "}R refresh from server · Esc back</Text>
            </Box>
          </Box>
        )}

        {/* Empty state */}
        {!toolsLoading && !toolsError && tools.length === 0 && (
          <Box flexDirection="column">
            <Text dimColor>{"  "}No tools available for this server.</Text>
            <Text dimColor>
              {"  "}Press R to sync tools from the MCP server.
            </Text>
            <Box marginTop={1}>
              <Text dimColor>{"  "}R refresh · Esc back</Text>
            </Box>
          </Box>
        )}

        {/* Tools list */}
        {!toolsLoading && !toolsError && tools.length > 0 && (
          <Box flexDirection="column">
            {pageTools.map((tool, index) => {
              const isSelected = index === toolsSelectedIndex;
              const isAttached = attachedToolIds.has(tool.id);
              const toolName = tool.name || "Unnamed tool";
              const toolDesc = tool.description || "No description";
              const statusIndicator = isAttached ? "✓" : " ";

              return (
                <Box key={tool.id} flexDirection="column" marginBottom={1}>
                  {/* Row 1: Selection indicator, attachment status, and tool name */}
                  <Box flexDirection="row">
                    <Text
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isSelected ? "> " : "  "}
                    </Text>
                    <Text
                      color={isAttached ? "green" : "gray"}
                      bold={isAttached}
                    >
                      [{statusIndicator}]
                    </Text>
                    <Text> </Text>
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {toolName}
                    </Text>
                  </Box>
                  {/* Row 2: Description */}
                  <Box flexDirection="row">
                    <Text dimColor>
                      {"      "}
                      {truncateText(toolDesc, terminalWidth - 6)}
                    </Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}

        {/* Footer with pagination and controls */}
        {!toolsLoading &&
          !toolsError &&
          tools.length > 0 &&
          (() => {
            const attachedFromThisServer = tools.filter((t) =>
              attachedToolIds.has(t.id),
            ).length;
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>
                  {"  "}
                  {toolsTotalPages > 1 &&
                    `Page ${toolsPage + 1}/${toolsTotalPages} · `}
                  {attachedFromThisServer}/{tools.length} attached from server ·{" "}
                  {attachedToolIds.size} total on agent
                </Text>
                <Text dimColor>
                  {"  "}Space/Enter toggle · ↑↓ navigate · A attach all · D
                  detach all · R refresh · Esc back
                </Text>
              </Box>
            );
          })()}
      </Box>
    );
  }

  // Delete confirmation UI
  if (mode === "confirming-delete" && selectedServer) {
    const options = ["Yes, delete", "No, cancel"];
    return (
      <Box flexDirection="column">
        {/* Command header */}
        <Text dimColor>{"> /mcp"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        {/* Title */}
        <Box marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Delete MCP server?
          </Text>
        </Box>

        <Text>
          {"  "}Delete "{selectedServer.server_name}"?
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const isSelected = index === deleteConfirmIndex;
            return (
              <Box key={option}>
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  bold={isSelected}
                >
                  {isSelected ? "> " : "  "}
                  {option}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Main browsing UI
  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /mcp"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Manage MCP servers
        </Text>
      </Box>

      {/* Loading state */}
      {loading && (
        <Box>
          <Text dimColor>{"  "}Loading MCP servers...</Text>
        </Box>
      )}

      {/* Error state */}
      {!loading && error && (
        <Box flexDirection="column">
          <Text color="red">
            {"  "}Error: {error}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>{"  "}R refresh · Esc cancel</Text>
          </Box>
        </Box>
      )}

      {/* Empty state */}
      {!loading && !error && servers.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>{"  "}No MCP servers configured.</Text>
          <Text dimColor>{"  "}Press A to add a new server.</Text>
          <Box marginTop={1}>
            <Text dimColor>{"  "}A add · Esc cancel</Text>
          </Box>
        </Box>
      )}

      {/* Server list */}
      {!loading && !error && servers.length > 0 && (
        <Box flexDirection="column">
          {pageServers.map((server, index) => {
            const isSelected = index === selectedIndex;
            const serverType = getServerTypeDisplay(server);
            const target = getServerTarget(server);

            // Calculate available width for target display
            const nameLen = server.server_name.length;
            const typeLen = serverType.length;
            const fixedChars = 4 + 3 + 3 + typeLen; // "  > " + " · " + " · " + type
            const availableForTarget = Math.max(
              20,
              terminalWidth - nameLen - fixedChars,
            );
            const displayTarget = truncateText(target, availableForTarget);

            return (
              <Box
                key={server.id || server.server_name}
                flexDirection="column"
                marginBottom={1}
              >
                {/* Row 1: Selection indicator, name, type, and target */}
                <Box flexDirection="row">
                  <Text
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isSelected ? "> " : "  "}
                  </Text>
                  <Text
                    bold={isSelected}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {server.server_name}
                  </Text>
                  <Text dimColor>
                    {" "}
                    · {serverType} · {displayTarget}
                  </Text>
                </Box>
                {/* Row 2: Server ID if available */}
                {server.id && (
                  <Box flexDirection="row">
                    <Text dimColor>
                      {"  "}ID: {server.id}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Footer with pagination and controls */}
      {!loading && !error && servers.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {totalPages > 1 && (
            <Text dimColor>
              {"  "}Page {currentPage + 1}/{totalPages}
            </Text>
          )}
          <Text dimColor>
            {"  "}Enter view tools · ↑↓ navigate · A add · D delete · R refresh
            · Esc cancel
          </Text>
        </Box>
      )}
    </Box>
  );
});

McpSelector.displayName = "McpSelector";
