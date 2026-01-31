/**
 * Interactive TUI for connecting to MCP servers with OAuth support.
 * Flow: Select transport → Enter URL → Connect (OAuth if needed) → Enter name → Create
 */

import { Box, useInput } from "ink";
import { memo, useCallback, useState } from "react";
import { getClient } from "../../agent/client";
import {
  connectMcpServer,
  type McpConnectConfig,
  type McpTool,
  OauthStreamEvent,
} from "../helpers/mcpOauth";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

const SOLID_LINE = "─";

// Validate URL (outside component to avoid useCallback dependency)
function validateUrl(url: string): string | null {
  if (!url.trim()) {
    return "URL is required";
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "URL must use http or https protocol";
    }
  } catch {
    return "Invalid URL format";
  }
  return null;
}

// Validate server name (outside component to avoid useCallback dependency)
function validateName(name: string): string | null {
  if (!name.trim()) {
    return "Server name is required";
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
    return "Name can only contain letters, numbers, hyphens, and underscores";
  }
  if (name.trim().length > 64) {
    return "Name must be 64 characters or less";
  }
  return null;
}

interface McpConnectFlowProps {
  onComplete: (serverName: string, serverId: string, toolCount: number) => void;
  onCancel: () => void;
}

type Step =
  | "select-transport"
  | "enter-url"
  | "connecting"
  | "enter-name"
  | "creating";

type Transport = "http" | "sse";

const TRANSPORTS: { value: Transport; label: string; description: string }[] = [
  {
    value: "http",
    label: "Streamable HTTP",
    description: "Modern HTTP-based transport (recommended)",
  },
  {
    value: "sse",
    label: "Server-Sent Events",
    description: "SSE-based transport for legacy servers",
  },
];

export const McpConnectFlow = memo(function McpConnectFlow({
  onComplete,
  onCancel,
}: McpConnectFlowProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  // Step state
  const [step, setStep] = useState<Step>("select-transport");

  // Transport selection
  const [transportIndex, setTransportIndex] = useState(0);
  const [selectedTransport, setSelectedTransport] = useState<Transport | null>(
    null,
  );

  // URL input
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");

  // Connection state
  const [connectionStatus, setConnectionStatus] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = useState<McpTool[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Name input
  const [nameInput, setNameInput] = useState("");
  const [nameError, setNameError] = useState("");

  // Creating state
  const [creatingStatus, setCreatingStatus] = useState("");

  // Handle transport selection
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (key.escape) {
        onCancel();
        return;
      }

      if (step === "select-transport") {
        if (key.upArrow) {
          setTransportIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setTransportIndex((prev) =>
            Math.min(TRANSPORTS.length - 1, prev + 1),
          );
        } else if (key.return) {
          const selected = TRANSPORTS[transportIndex];
          if (selected) {
            setSelectedTransport(selected.value);
            setStep("enter-url");
          }
        }
      }
    },
    { isActive: step === "select-transport" },
  );

  // Handle URL input escape
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (key.escape) {
        // Go back to transport selection
        setStep("select-transport");
        setUrlInput("");
        setUrlError("");
      }
    },
    { isActive: step === "enter-url" },
  );

  // Handle connection step escape
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (key.escape && connectionError) {
        // Go back to URL input on error
        setStep("enter-url");
        setConnectionError(null);
        setConnectionStatus("");
        setAuthUrl(null);
      }
    },
    { isActive: step === "connecting" },
  );

  // Handle name input escape
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (key.escape) {
        // Go back to URL input
        setStep("enter-url");
        setNameInput("");
        setNameError("");
      }
    },
    { isActive: step === "enter-name" },
  );

  // Handle URL submission
  const handleUrlSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const error = validateUrl(trimmed);
      if (error) {
        setUrlError(error);
        return;
      }

      setUrlError("");
      setStep("connecting");
      setConnectionStatus("Connecting...");
      setConnectionError(null);
      setAuthUrl(null);

      const config: McpConnectConfig = {
        server_name: "temp-connection-test",
        type: selectedTransport === "http" ? "streamable_http" : "sse",
        server_url: trimmed,
      };

      try {
        const tools = await connectMcpServer(config, {
          onEvent: (event) => {
            switch (event.event) {
              case OauthStreamEvent.CONNECTION_ATTEMPT:
                setConnectionStatus("Connecting to server...");
                break;
              case OauthStreamEvent.OAUTH_REQUIRED:
                setConnectionStatus("OAuth authentication required...");
                break;
              case OauthStreamEvent.AUTHORIZATION_URL:
                if (event.url) {
                  const authorizationUrl = event.url;
                  setAuthUrl(authorizationUrl);
                  setConnectionStatus("Opening browser for authorization...");
                  // Open browser
                  import("open")
                    .then(({ default: open }) => open(authorizationUrl))
                    .catch(() => {});
                }
                break;
              case OauthStreamEvent.WAITING_FOR_AUTH:
                setConnectionStatus("Waiting for authorization in browser...");
                break;
            }
          },
        });

        // Success!
        setDiscoveredTools(tools);
        setConnectionStatus("");

        // Generate default name from URL
        try {
          const parsed = new URL(trimmed);
          const defaultName =
            parsed.hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] ||
            "mcp-server";
          setNameInput(defaultName);
        } catch {
          setNameInput("mcp-server");
        }

        setStep("enter-name");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setConnectionError(message);
        setConnectionStatus("");
      }
    },
    [selectedTransport],
  );

  // Handle name submission and create server
  const handleNameSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const error = validateName(trimmed);
      if (error) {
        setNameError(error);
        return;
      }

      setNameError("");
      setStep("creating");
      setCreatingStatus("Creating MCP server...");

      try {
        const client = await getClient();

        const serverConfig =
          selectedTransport === "http"
            ? {
                mcp_server_type: "streamable_http" as const,
                server_url: urlInput.trim(),
              }
            : {
                mcp_server_type: "sse" as const,
                server_url: urlInput.trim(),
              };

        const server = await client.mcpServers.create({
          server_name: trimmed,
          config: serverConfig,
        });

        onComplete(trimmed, server.id || "", discoveredTools.length);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNameError(`Failed to create server: ${message}`);
        setStep("enter-name");
        setCreatingStatus("");
      }
    },
    [selectedTransport, urlInput, discoveredTools.length, onComplete],
  );

  // Render transport selection step
  if (step === "select-transport") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /mcp connect"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        <Text bold color={colors.selector.title}>
          Connect to MCP Server
        </Text>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text>Select transport type:</Text>
        </Box>

        <Box height={1} />

        <Box flexDirection="column">
          {TRANSPORTS.map((transport, index) => {
            const isSelected = index === transportIndex;
            return (
              <Box
                key={transport.value}
                flexDirection="column"
                marginBottom={1}
              >
                <Box>
                  <Text
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                    bold={isSelected}
                  >
                    {isSelected ? "> " : "  "}
                    {transport.label}
                  </Text>
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor>{transport.description}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // Render URL input step
  if (step === "enter-url") {
    const transportLabel =
      TRANSPORTS.find((t) => t.value === selectedTransport)?.label || "";

    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /mcp connect"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        <Text bold color={colors.selector.title}>
          Connect to MCP Server
        </Text>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text>
            Transport: <Text bold>{transportLabel}</Text>
          </Text>
        </Box>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text>Enter the server URL:</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={urlInput}
            onChange={(val) => {
              setUrlInput(val);
              setUrlError("");
            }}
            onSubmit={handleUrlSubmit}
            placeholder="https://mcp.example.com/mcp"
          />
        </Box>

        {urlError && (
          <Box paddingLeft={2} marginTop={1}>
            <Text color="red">{urlError}</Text>
          </Box>
        )}

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text dimColor>Enter submit · Esc back</Text>
        </Box>
      </Box>
    );
  }

  // Render connecting step
  if (step === "connecting") {
    const transportLabel =
      TRANSPORTS.find((t) => t.value === selectedTransport)?.label || "";

    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /mcp connect"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        <Text bold color={colors.selector.title}>
          Connect to MCP Server
        </Text>

        <Box height={1} />

        <Box paddingLeft={2} flexDirection="column">
          <Text>
            Transport: <Text bold>{transportLabel}</Text>
          </Text>
          <Text>
            URL: <Text bold>{urlInput}</Text>
          </Text>
        </Box>

        <Box height={1} />

        {connectionStatus && (
          <Box paddingLeft={2}>
            <Text color="yellow">{connectionStatus}</Text>
          </Box>
        )}

        {authUrl && (
          <Box paddingLeft={2} marginTop={1} flexDirection="column">
            <Text dimColor>Authorization URL:</Text>
            <Text dimColor>{authUrl}</Text>
          </Box>
        )}

        {connectionError && (
          <Box paddingLeft={2} marginTop={1} flexDirection="column">
            <Text color="red">Connection failed:</Text>
            <Text color="red">{connectionError}</Text>
            <Box marginTop={1}>
              <Text dimColor>Esc to go back and try again</Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  // Render name input step
  if (step === "enter-name") {
    const transportLabel =
      TRANSPORTS.find((t) => t.value === selectedTransport)?.label || "";

    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /mcp connect"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        <Text bold color={colors.selector.title}>
          Connect to MCP Server
        </Text>

        <Box height={1} />

        <Box paddingLeft={2} flexDirection="column">
          <Text>
            Transport: <Text bold>{transportLabel}</Text>
          </Text>
          <Text>
            URL: <Text bold>{urlInput}</Text>
          </Text>
        </Box>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text color="green">
            ✓ Connection successful! Discovered {discoveredTools.length} tool
            {discoveredTools.length === 1 ? "" : "s"}
          </Text>
        </Box>

        {discoveredTools.length > 0 && (
          <Box paddingLeft={4} marginTop={1} flexDirection="column">
            {discoveredTools.slice(0, 5).map((tool) => (
              <Text key={tool.name} dimColor>
                • {tool.name}
              </Text>
            ))}
            {discoveredTools.length > 5 && (
              <Text dimColor>... and {discoveredTools.length - 5} more</Text>
            )}
          </Box>
        )}

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text>Enter a name for this server:</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={nameInput}
            onChange={(val) => {
              setNameInput(val);
              setNameError("");
            }}
            onSubmit={handleNameSubmit}
            placeholder="my-mcp-server"
          />
        </Box>

        {nameError && (
          <Box paddingLeft={2} marginTop={1}>
            <Text color="red">{nameError}</Text>
          </Box>
        )}

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text dimColor>Enter create · Esc back</Text>
        </Box>
      </Box>
    );
  }

  // Render creating step
  if (step === "creating") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /mcp connect"}</Text>
        <Text dimColor>{solidLine}</Text>

        <Box height={1} />

        <Text bold color={colors.selector.title}>
          Connect to MCP Server
        </Text>

        <Box height={1} />

        <Box paddingLeft={2}>
          <Text color="yellow">{creatingStatus}</Text>
        </Box>
      </Box>
    );
  }

  return null;
});

McpConnectFlow.displayName = "McpConnectFlow";
