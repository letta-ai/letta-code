import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getBackend } from "../../backend";
import {
  handleMcpAdd,
  type McpCommandContext,
  setActiveCommandId as setActiveMcpCommandId,
} from "../commands/mcp";
import type { Buffers } from "../helpers/accumulator";
import type { ActiveOverlay, AppCommandRunner } from "./types";

type SubmitCommandResult = { submitted: boolean };

type ModelSelectorOptions = {
  filterProvider?: string;
  forceRefresh?: boolean;
};

type ConnectionCommandContext = {
  agentId: string;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  conversationIdRef: MutableRefObject<string>;
  refreshDerived: () => void;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setCommandRunning: (value: boolean) => void;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  startOverlayCommand: (
    overlay: ActiveOverlay,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
};

export async function handleConnectionCommand(
  msg: string,
  trimmed: string,
  ctx: ConnectionCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    buffersRef,
    commandRunner,
    conversationIdRef,
    refreshDerived,
    setActiveOverlay,
    setCommandRunning,
    setModelSelectorOptions,
    startOverlayCommand,
  } = ctx;

  if (trimmed.startsWith("/mcp")) {
    const mcpCtx: McpCommandContext = {
      buffersRef,
      refreshDerived,
      setCommandRunning,
    };

    const afterMcp = trimmed.slice(4).trim();
    const firstWord = afterMcp.split(/\s+/)[0]?.toLowerCase();

    if (
      firstWord !== "help" &&
      !getBackend().capabilities.serverSideToolManagement
    ) {
      const cmd = commandRunner.start(msg, "Checking MCP support...");
      cmd.fail(
        "MCP server management is not supported by the local backend yet.",
      );
      return { submitted: true };
    }

    if (!firstWord) {
      startOverlayCommand(
        "mcp",
        "/mcp",
        "Opening MCP server manager...",
        "MCP dialog dismissed",
      );
      setActiveOverlay("mcp");
      return { submitted: true };
    }

    if (firstWord === "add") {
      const afterAdd = afterMcp.slice(firstWord.length).trim();
      const cmd = commandRunner.start(msg, "Adding MCP server...");
      setActiveMcpCommandId(cmd.id);
      try {
        await handleMcpAdd(mcpCtx, msg, afterAdd);
      } finally {
        setActiveMcpCommandId(null);
      }
      return { submitted: true };
    }

    if (firstWord === "connect") {
      startOverlayCommand(
        "mcp-connect",
        "/mcp connect",
        "Opening MCP connect flow...",
        "MCP connect dismissed",
      );
      setActiveOverlay("mcp-connect");
      return { submitted: true };
    }

    if (firstWord === "help") {
      const cmd = commandRunner.start(msg, "Showing MCP help...");
      const output = [
        "/mcp help",
        "",
        "Manage MCP servers.",
        "",
        "USAGE",
        "  /mcp              — open MCP server manager",
        "  /mcp add ...      — add a new server (without OAuth)",
        "  /mcp connect      — interactive wizard with OAuth support",
        "  /mcp help         — show this help",
        "",
        "EXAMPLES",
        "  /mcp add --transport http notion https://mcp.notion.com/mcp",
      ].join("\n");
      cmd.finish(output, true);
      return { submitted: true };
    }

    const cmd = commandRunner.start(msg, "Checking MCP usage...");
    cmd.fail(`Unknown subcommand: "${firstWord}". Run /mcp help for usage.`);
    return { submitted: true };
  }

  if (trimmed === "/connect") {
    startOverlayCommand(
      "connect",
      "/connect",
      "Opening provider selector...",
      "Connect dialog dismissed",
    );
    setActiveOverlay("connect");
    return { submitted: true };
  }

  if (trimmed.startsWith("/connect ")) {
    const cmd = commandRunner.start(msg, "Starting connection...");
    const { handleConnect, setActiveCommandId: setActiveConnectCommandId } =
      await import("../commands/connect");
    setActiveConnectCommandId(cmd.id);
    try {
      await handleConnect(
        {
          buffersRef,
          refreshDerived,
          setCommandRunning,
          onCodexConnected: () => {
            setModelSelectorOptions({
              filterProvider: "chatgpt-plus-pro",
              forceRefresh: true,
            });
            startOverlayCommand(
              "model",
              "/model",
              "Opening model selector...",
              "Models dialog dismissed",
            );
            setActiveOverlay("model");
          },
        },
        msg,
      );
    } finally {
      setActiveConnectCommandId(null);
    }
    return { submitted: true };
  }

  if (trimmed.startsWith("/disconnect")) {
    const cmd = commandRunner.start(msg, "Disconnecting...");
    const { handleDisconnect, setActiveCommandId: setActiveConnectCommandId } =
      await import("../commands/connect");
    setActiveConnectCommandId(cmd.id);
    try {
      await handleDisconnect(
        {
          buffersRef,
          refreshDerived,
          setCommandRunning,
        },
        msg,
      );
    } finally {
      setActiveConnectCommandId(null);
    }
    return { submitted: true };
  }

  // Special handling for /server command (alias: /remote)
  if (
    trimmed === "/server" ||
    trimmed.startsWith("/server ") ||
    trimmed === "/remote" ||
    trimmed.startsWith("/remote ")
  ) {
    const parts = Array.from(
      trimmed.matchAll(
        /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g,
      ),
      (match) => match[1] ?? match[2] ?? match[3],
    );

    let name: string | undefined;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      if (part === "--env-name" && nextPart) {
        name = nextPart;
        i++;
      }
    }

    const cmd = commandRunner.start(msg, "Starting listener...");
    const { handleListen, setActiveCommandId: setActiveListenCommandId } =
      await import("../commands/listen");
    setActiveListenCommandId(cmd.id);
    try {
      await handleListen(
        {
          buffersRef,
          refreshDerived,
          setCommandRunning,
          agentId,
          conversationId: conversationIdRef.current,
        },
        msg,
        { envName: name },
      );
    } finally {
      setActiveListenCommandId(null);
    }
    return { submitted: true };
  }

  // Special handling for /help command
  return null;
}
