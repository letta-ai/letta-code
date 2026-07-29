import { Box, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import type { McpServerConfig } from "@/mcp-client";
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

type Mode = "browsing" | "confirming-delete" | "viewing-tools";

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
  const [states, setStates] = useState<ClientMcpServerState[]>(() =>
    getClientMcpServerStates(agentId),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<Mode>("browsing");
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1);
  const [viewingState, setViewingState] = useState<ClientMcpServerState | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const configs = settingsManager.getMcpServers(agentId);
      setStates(await replaceClientMcpServers(agentId, configs));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

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

  useEffect(() => {
    setStates(getClientMcpServerStates(agentId));
    void refresh();
  }, [agentId, refresh]);

  const totalPages = Math.max(1, Math.ceil(states.length / DISPLAY_PAGE_SIZE));
  const pageStates = states.slice(
    page * DISPLAY_PAGE_SIZE,
    (page + 1) * DISPLAY_PAGE_SIZE,
  );
  const selected = pageStates[selectedIndex];

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (loading) return;

    if (mode === "confirming-delete") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((current) => (current === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0 && selected)
          void removeServer(selected.config);
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

    if (key.upArrow) {
      if (selectedIndex === 0 && page > 0) {
        setPage((current) => current - 1);
        setSelectedIndex(DISPLAY_PAGE_SIZE - 1);
      } else {
        setSelectedIndex((current) => Math.max(0, current - 1));
      }
    } else if (key.downArrow) {
      if (selectedIndex === pageStates.length - 1 && page < totalPages - 1) {
        setPage((current) => current + 1);
        setSelectedIndex(0);
      } else {
        setSelectedIndex((current) =>
          Math.min(Math.max(0, pageStates.length - 1), current + 1),
        );
      }
    } else if (key.return && selected) {
      setViewingState(selected);
      setMode("viewing-tools");
    } else if (input === "a" || input === "A") {
      onAdd();
    } else if ((input === "d" || input === "D") && selected) {
      setDeleteConfirmIndex(1);
      setMode("confirming-delete");
    } else if (input === "r" || input === "R") {
      void refresh();
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
              <Text>{tool.name}</Text>
              <Text dimColor>
                {"  "}
                {truncateText(tool.description, terminalWidth - 2)}
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

  if (mode === "confirming-delete" && selected) {
    return (
      <Frame solidLine={solidLine}>
        <Text bold color={colors.selector.title}>
          Remove client-local MCP server?
        </Text>
        <Text>Remove "{selected.config.name}" and stop its process?</Text>
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
      <Text dimColor>
        Servers run on this machine and their tools are available only to this
        agent.
      </Text>
      <Box height={1} />
      {loading ? (
        <Text dimColor>Connecting MCP servers...</Text>
      ) : error ? (
        <Text color="red">Error: {error}</Text>
      ) : states.length === 0 ? (
        <Text dimColor>No client-local MCP servers configured.</Text>
      ) : (
        pageStates.map((state, index) => {
          const isSelected = index === selectedIndex;
          const status = state.status === "connected" ? "connected" : "failed";
          const target = describeTarget(state.config);
          return (
            <Box
              key={state.config.name}
              flexDirection="column"
              marginBottom={1}
            >
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
                {state.config.name} · {transportName(state.config)} · {status}
              </Text>
              <Text dimColor>
                {"  "}
                {truncateText(target, terminalWidth - 2)} · {state.tools.length}{" "}
                tools
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1} flexDirection="column">
        {totalPages > 1 && (
          <Text dimColor>
            Page {page + 1}/{totalPages}
          </Text>
        )}
        <Text dimColor>
          Enter tools · A add · D remove · R reconnect · Esc close
        </Text>
      </Box>
    </Frame>
  );
});

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

function describeTarget(config: McpServerConfig): string {
  if (config.transport === "http" || config.transport === "sse") {
    return config.url;
  }
  return [config.command, ...(config.args ?? [])].join(" ");
}

function transportName(config: McpServerConfig): string {
  return config.transport ?? "stdio";
}
