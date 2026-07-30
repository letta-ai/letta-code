import { Box, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  type AgentMcpAttachment,
  attachedToolNamesForEntry,
  attachmentsForEntry,
  attachServerMcpTools,
  describeServerMcpTarget,
  detachServerMcpTools,
  listAgentMcpAttachments,
  loadServerMcpEntries,
  planServerMcpToggle,
  refreshServerMcpServer,
  type ServerMcpEntry,
} from "@/backend/api/mcp-servers";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import type { McpServerConfig } from "@/mcp-client";
import { clearMcpOAuthCredentials } from "@/mcp-oauth";
import {
  type ClientMcpServerState,
  getClientMcpServerStates,
  replaceClientMcpServers,
} from "@/mcp-runtime";
import { settingsManager } from "@/settings-manager";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DISPLAY_PAGE_SIZE = 7;
const TOOLS_WINDOW_SIZE = 10;

type Mode =
  | "browsing"
  | "confirming-delete"
  | "viewing-tools"
  | "viewing-server-tools";

export type McpRow =
  | { kind: "local"; state: ClientMcpServerState }
  | { kind: "server"; entry: ServerMcpEntry };

export function buildMcpRows(
  localStates: ClientMcpServerState[],
  serverEntries: ServerMcpEntry[],
): McpRow[] {
  return [
    ...localStates.map((state): McpRow => ({ kind: "local", state })),
    ...serverEntries.map((entry): McpRow => ({ kind: "server", entry })),
  ];
}

interface McpSelectorProps {
  agentId: string;
  onAdd: () => void;
  onCancel: () => void;
}

export const McpSelector = memo(function McpSelector({
  agentId,
  onAdd,
  onCancel,
}: McpSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const serverSideSupported =
    getBackend().capabilities.serverSideToolManagement;
  const [states, setStates] = useState<ClientMcpServerState[]>(() =>
    getClientMcpServerStates(agentId),
  );
  const [serverEntries, setServerEntries] = useState<ServerMcpEntry[]>([]);
  const [attachments, setAttachments] = useState<AgentMcpAttachment[]>([]);
  const [serverLoading, setServerLoading] = useState(serverSideSupported);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<Mode>("browsing");
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1);
  const [viewingState, setViewingState] = useState<ClientMcpServerState | null>(
    null,
  );
  const [viewingServerId, setViewingServerId] = useState<string | null>(null);
  const [pendingToolNames, setPendingToolNames] = useState<Set<string> | null>(
    null,
  );
  const [toolIndex, setToolIndex] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatusMessage(null);
    setError(null);
    try {
      const configs = settingsManager.getMcpServers(agentId);
      setStates(
        await replaceClientMcpServers(agentId, configs, {
          interactiveOAuth: true,
          onStatus: setStatusMessage,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const loadServerData = useCallback(async () => {
    if (!serverSideSupported) return;
    setServerLoading(true);
    setServerError(null);
    try {
      const client = await getClient();
      const [entries, agentAttachments] = await Promise.all([
        loadServerMcpEntries(client),
        listAgentMcpAttachments(client, agentId),
      ]);
      setServerEntries(entries);
      setAttachments(agentAttachments);
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setServerLoading(false);
    }
  }, [agentId, serverSideSupported]);

  const removeServer = useCallback(
    async (config: McpServerConfig) => {
      setLoading(true);
      setError(null);
      try {
        const configs = settingsManager
          .getMcpServers(agentId)
          .filter((server) => server.name !== config.name);
        settingsManager.setMcpServers(agentId, configs);
        await settingsManager.flush();
        if (config.transport === "http" || config.transport === "sse") {
          await clearMcpOAuthCredentials(agentId, config.name, config.url);
        }
        setStates(await replaceClientMcpServers(agentId, configs));
        setSelectedIndex(0);
        setPage(0);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
        setMode("browsing");
      }
    },
    [agentId],
  );

  const toggleServer = useCallback(
    async (entry: ServerMcpEntry) => {
      setBusy(true);
      setError(null);
      try {
        const plan = planServerMcpToggle(entry, attachments);
        const client = await getClient();
        if (plan.action === "attach") {
          if (plan.toolNames.length === 0) return;
          await attachServerMcpTools(
            client,
            agentId,
            entry.server.server_name,
            plan.toolNames,
          );
        } else {
          await detachServerMcpTools(client, agentId, plan.toolIds);
        }
        setAttachments(await listAgentMcpAttachments(client, agentId));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [agentId, attachments],
  );

  const applyServerToolSelection = useCallback(
    async (entry: ServerMcpEntry) => {
      const pending = pendingToolNames;
      if (!pending) return;
      setBusy(true);
      setError(null);
      try {
        const client = await getClient();
        const entryAttachments = attachmentsForEntry(entry, attachments);
        const attachedNames = new Set(
          entryAttachments.map((attachment) => attachment.toolName),
        );
        const liveNames = new Set(entry.tools.map((tool) => tool.name));
        const toAttach = [...pending].filter(
          (name) => liveNames.has(name) && !attachedNames.has(name),
        );
        const toDetach = entryAttachments
          .filter((attachment) => !pending.has(attachment.toolName))
          .map((attachment) => attachment.toolId);
        if (toAttach.length > 0) {
          await attachServerMcpTools(
            client,
            agentId,
            entry.server.server_name,
            toAttach,
          );
        }
        if (toDetach.length > 0) {
          await detachServerMcpTools(client, agentId, toDetach);
        }
        setAttachments(await listAgentMcpAttachments(client, agentId));
        setViewingServerId(null);
        setPendingToolNames(null);
        setMode("browsing");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [agentId, attachments, pendingToolNames],
  );

  const refreshServerSchemas = useCallback(
    async (entry: ServerMcpEntry) => {
      if (!entry.server.id) return;
      setBusy(true);
      setError(null);
      try {
        const client = await getClient();
        await refreshServerMcpServer(client, entry.server.id, agentId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
      await loadServerData();
    },
    [agentId, loadServerData],
  );

  useEffect(() => {
    const currentStates = getClientMcpServerStates(agentId);
    setStates(currentStates);
    if (
      currentStates.length !== settingsManager.getMcpServers(agentId).length
    ) {
      void refresh();
    }
    void loadServerData();
  }, [agentId, refresh, loadServerData]);

  const rows = buildMcpRows(states, serverEntries);
  const totalPages = Math.max(1, Math.ceil(rows.length / DISPLAY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(
    safePage * DISPLAY_PAGE_SIZE,
    (safePage + 1) * DISPLAY_PAGE_SIZE,
  );
  const safeIndex = Math.min(selectedIndex, Math.max(0, pageRows.length - 1));
  const selected = pageRows[safeIndex];
  const viewingEntry =
    viewingServerId !== null
      ? (serverEntries.find((entry) => entry.server.id === viewingServerId) ??
        null)
      : null;

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (loading || busy) return;

    if (mode === "confirming-delete") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((current) => (current === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0 && selected?.kind === "local")
          void removeServer(selected.state.config);
        else setMode("browsing");
      } else if (key.escape) {
        setMode("browsing");
      }
      return;
    }

    if (mode === "viewing-tools") {
      if (key.escape) {
        setViewingState(null);
        setMode("browsing");
      } else if (input === "r" || input === "R") {
        setViewingState(null);
        setMode("browsing");
        void refresh();
      }
      return;
    }

    if (mode === "viewing-server-tools") {
      if (key.escape) {
        setViewingServerId(null);
        setPendingToolNames(null);
        setMode("browsing");
        return;
      }
      if (!viewingEntry) return;
      const tools = viewingEntry.tools;
      if (key.upArrow) {
        setToolIndex((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setToolIndex((current) =>
          Math.min(Math.max(0, tools.length - 1), current + 1),
        );
      } else if (input === " ") {
        const tool = tools[Math.min(toolIndex, Math.max(0, tools.length - 1))];
        if (tool) {
          setPendingToolNames((current) => {
            const next = new Set(current ?? []);
            if (next.has(tool.name)) next.delete(tool.name);
            else next.add(tool.name);
            return next;
          });
        }
      } else if (input === "a" || input === "A") {
        setPendingToolNames(new Set(tools.map((tool) => tool.name)));
      } else if (input === "n" || input === "N") {
        setPendingToolNames(new Set());
      } else if (key.return) {
        void applyServerToolSelection(viewingEntry);
      } else if (input === "r" || input === "R") {
        void refreshServerSchemas(viewingEntry);
      }
      return;
    }

    if (key.upArrow) {
      if (safeIndex === 0 && safePage > 0) {
        setPage(safePage - 1);
        setSelectedIndex(DISPLAY_PAGE_SIZE - 1);
      } else {
        setSelectedIndex(Math.max(0, safeIndex - 1));
      }
    } else if (key.downArrow) {
      if (safeIndex === pageRows.length - 1 && safePage < totalPages - 1) {
        setPage(safePage + 1);
        setSelectedIndex(0);
      } else {
        setSelectedIndex(
          Math.min(Math.max(0, pageRows.length - 1), safeIndex + 1),
        );
      }
    } else if (key.return && selected) {
      if (selected.kind === "local") {
        setViewingState(selected.state);
        setMode("viewing-tools");
      } else {
        setViewingServerId(selected.entry.server.id ?? null);
        setPendingToolNames(
          attachedToolNamesForEntry(selected.entry, attachments),
        );
        setToolIndex(0);
        setMode("viewing-server-tools");
      }
    } else if (input === " " && selected?.kind === "server") {
      void toggleServer(selected.entry);
    } else if (input === "a" || input === "A") {
      onAdd();
    } else if ((input === "d" || input === "D") && selected) {
      if (selected.kind === "local") {
        setDeleteConfirmIndex(1);
        setMode("confirming-delete");
      } else {
        setStatusMessage(
          "Remote MCP servers are managed on the Letta server (ADE/API).",
        );
      }
    } else if (input === "r" || input === "R") {
      void refresh();
      void loadServerData();
    } else if (key.escape) {
      onCancel();
    }
  });

  if (mode === "viewing-tools" && viewingState) {
    return (
      <Frame solidLine={solidLine}>
        <Text bold color={colors.selector.title}>
          Tools for {viewingState.config.name}
        </Text>
        <Box height={1} />
        {viewingState.status === "failed" ? (
          <Text color="red">Connection failed: {viewingState.error}</Text>
        ) : viewingState.tools.length === 0 ? (
          <Text dimColor>No tools discovered.</Text>
        ) : (
          viewingState.tools.map((tool) => (
            <Box key={tool.registrationKey ?? tool.name} flexDirection="column">
              <Text>{tool.label ?? tool.name}</Text>
              <Text dimColor>
                {"  "}
                {truncateText(singleLine(tool.description), terminalWidth - 2)}
              </Text>
            </Box>
          ))
        )}
        <Box marginTop={1}>
          <Text dimColor>R reconnect · Esc back</Text>
        </Box>
      </Frame>
    );
  }

  if (mode === "viewing-server-tools" && viewingEntry) {
    const tools = viewingEntry.tools;
    const attachedNames = attachedToolNamesForEntry(viewingEntry, attachments);
    const checkedNames = pendingToolNames ?? attachedNames;
    const hasChanges =
      checkedNames.size !== attachedNames.size ||
      [...checkedNames].some((name) => !attachedNames.has(name));
    const safeToolIndex = Math.min(toolIndex, Math.max(0, tools.length - 1));
    const windowStart = Math.max(
      0,
      Math.min(
        safeToolIndex - Math.floor(TOOLS_WINDOW_SIZE / 2),
        tools.length - TOOLS_WINDOW_SIZE,
      ),
    );
    const windowTools = tools.slice(
      windowStart,
      windowStart + TOOLS_WINDOW_SIZE,
    );
    return (
      <Frame solidLine={solidLine}>
        <Text bold color={colors.selector.title}>
          Tools for {viewingEntry.server.server_name} (remote)
        </Text>
        <Text dimColor>
          Enabled tools run on the Letta server when this agent calls them.
        </Text>
        <Box height={1} />
        {busy ? (
          <Text dimColor>Applying changes…</Text>
        ) : viewingEntry.toolsError ? (
          <Text color="red">
            Failed to list tools: {viewingEntry.toolsError}
          </Text>
        ) : tools.length === 0 ? (
          <Text dimColor>No tools discovered.</Text>
        ) : (
          windowTools.map((tool, index) => {
            const absoluteIndex = windowStart + index;
            const isSelected = absoluteIndex === safeToolIndex;
            const isChecked = checkedNames.has(tool.name);
            return (
              <Box key={tool.name} flexDirection="column">
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "❯ " : "  "}
                  {isChecked ? "[✔] " : "[ ] "}
                  {tool.name}
                </Text>
                <Text dimColor>
                  {"      "}
                  {truncateText(
                    singleLine(tool.description),
                    terminalWidth - 6,
                  )}
                </Text>
              </Box>
            );
          })
        )}
        {error && <Text color="red">Error: {error}</Text>}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            {checkedNames.size}/{tools.length} enabled
            {hasChanges ? " · unsaved changes" : ""}
          </Text>
          <Text dimColor>
            ↑↓ navigate · Space toggle · A all · N none · Enter apply · Esc
            cancel
          </Text>
        </Box>
      </Frame>
    );
  }

  if (mode === "confirming-delete" && selected?.kind === "local") {
    return (
      <Frame solidLine={solidLine}>
        <Text bold color={colors.selector.title}>
          Remove client-local MCP server?
        </Text>
        <Text>Remove "{selected.state.config.name}" and stop its process?</Text>
        <Box marginTop={1} flexDirection="column">
          {["Yes, remove", "No, cancel"].map((option, index) => (
            <Text
              key={option}
              bold={index === deleteConfirmIndex}
              color={
                index === deleteConfirmIndex
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {index === deleteConfirmIndex ? "> " : "  "}
              {option}
            </Text>
          ))}
        </Box>
      </Frame>
    );
  }

  return (
    <Frame solidLine={solidLine}>
      <Text bold color={colors.selector.title}>
        MCP servers for this agent
      </Text>
      <Box height={1} />
      {loading ? (
        <Text dimColor>{statusMessage ?? "Connecting MCP servers..."}</Text>
      ) : error ? (
        <Text color="red">Error: {error}</Text>
      ) : rows.length === 0 && !serverLoading ? (
        <Text dimColor>
          No MCP servers configured. Press A to add a local server.
        </Text>
      ) : (
        pageRows.map((row, index) => {
          const isSelected = index === safeIndex;
          const previous = index > 0 ? pageRows[index - 1] : undefined;
          const showHeader = index === 0 || previous?.kind !== row.kind;
          return (
            <Box key={rowKey(row)} flexDirection="column" marginBottom={1}>
              {showHeader && (
                <Box marginBottom={1}>
                  <Text bold dimColor>
                    {row.kind === "local"
                      ? "Local (this machine)"
                      : "Remote (global)"}
                  </Text>
                </Box>
              )}
              {row.kind === "local" ? (
                <LocalRow
                  state={row.state}
                  isSelected={isSelected}
                  terminalWidth={terminalWidth}
                />
              ) : (
                <ServerRow
                  entry={row.entry}
                  attachments={attachments}
                  isSelected={isSelected}
                  terminalWidth={terminalWidth}
                />
              )}
            </Box>
          );
        })
      )}
      {serverSideSupported && serverLoading && (
        <Text dimColor>Loading server-side MCP servers…</Text>
      )}
      {serverError && (
        <Text dimColor>Server-side MCP unavailable: {serverError}</Text>
      )}
      {busy && <Text dimColor>Updating…</Text>}
      {!loading && !error && statusMessage && (
        <Text dimColor>{statusMessage}</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {totalPages > 1 && (
          <Text dimColor>
            Page {safePage + 1}/{totalPages}
          </Text>
        )}
        <Text dimColor>
          Enter tools · Space enable/disable · A add · D remove · R refresh ·
          Esc close
        </Text>
      </Box>
    </Frame>
  );
});

function rowKey(row: McpRow): string {
  return row.kind === "local"
    ? `local:${row.state.config.name}`
    : `server:${row.entry.server.id ?? row.entry.server.server_name}`;
}

function LocalRow({
  state,
  isSelected,
  terminalWidth,
}: {
  state: ClientMcpServerState;
  isSelected: boolean;
  terminalWidth: number;
}) {
  const status = state.status === "connected" ? "connected" : "failed";
  const target = describeTarget(state.config);
  return (
    <>
      <Text
        bold={isSelected}
        color={isSelected ? colors.selector.itemHighlighted : undefined}
      >
        {isSelected ? "> " : "  "}
        {state.config.name} · {transportName(state.config)} · {status}
      </Text>
      <Text dimColor>
        {"  "}
        {truncateText(target, terminalWidth - 2)} · {state.tools.length} tools
      </Text>
    </>
  );
}

function ServerRow({
  entry,
  attachments,
  isSelected,
  terminalWidth,
}: {
  entry: ServerMcpEntry;
  attachments: readonly AgentMcpAttachment[];
  isSelected: boolean;
  terminalWidth: number;
}) {
  const attachedCount = attachmentsForEntry(entry, attachments).length;
  const status = entry.toolsError
    ? "unavailable"
    : attachedCount === 0
      ? "○ disabled"
      : attachedCount === entry.tools.length
        ? `◉ enabled · ${entry.tools.length} tools`
        : `◉ enabled · ${attachedCount}/${entry.tools.length} tools`;
  const target = describeServerMcpTarget(entry.server);
  return (
    <>
      <Text
        bold={isSelected}
        color={isSelected ? colors.selector.itemHighlighted : undefined}
      >
        {isSelected ? "> " : "  "}
        {entry.server.server_name} ·{" "}
        {entry.server.mcp_server_type ?? "streamable_http"} · {status}
      </Text>
      <Text dimColor>
        {"  "}
        {truncateText(target, terminalWidth - 2)}
      </Text>
    </>
  );
}

function Frame({
  children,
  solidLine,
}: {
  children: React.ReactNode;
  solidLine: string;
}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /mcp"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      {children}
    </Box>
  );
}

function singleLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function describeTarget(config: McpServerConfig): string {
  if (config.transport === "http" || config.transport === "sse") {
    return config.url;
  }
  return [config.command, ...(config.args ?? [])].join(" ");
}

function transportName(config: McpServerConfig): string {
  return config.transport ?? "stdio";
}
