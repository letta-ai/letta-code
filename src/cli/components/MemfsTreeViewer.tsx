import { Box, useInput } from "ink";
import Link from "ink-link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "@/agent/memory-scanner";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import type { MemoryFileEntry } from "@/types/protocol_v2";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

interface MemfsTreeViewerProps {
  agentId: string;
  entries: MemoryFileEntry[];
  onClose: () => void;
  conversationId?: string;
}

function remoteTree(entries: MemoryFileEntry[]): TreeNode[] {
  const children = new Map<string, Set<string>>();
  for (const entry of entries) {
    let parent = "";
    for (const name of entry.relative_path.split("/").filter(Boolean)) {
      const names = children.get(parent) ?? new Set();
      names.add(name);
      children.set(parent, names);
      parent = parent ? parent + "/" + name : name;
    }
  }
  const nodes: TreeNode[] = [];
  function visit(parent: string, ancestors: boolean[]) {
    const names = [...(children.get(parent) ?? [])].sort();
    names.forEach((name, index) => {
      const path = parent ? parent + "/" + name : name;
      const isLast = index === names.length - 1;
      const isDirectory = children.has(path);
      nodes.push({
        name: isDirectory ? name + "/" : name,
        relativePath: path,
        fullPath: path,
        depth: ancestors.length,
        parentIsLast: ancestors,
        isLast,
        isDirectory,
      });
      if (isDirectory) visit(path, [...ancestors, isLast]);
    });
  }
  visit("", []);
  return nodes;
}

function renderTreePrefix(node: TreeNode): string {
  let prefix = "";
  for (let i = 0; i < node.depth; i++) {
    prefix += node.parentIsLast[i] ? "    " : "│   ";
  }
  prefix += node.isLast ? "└── " : "├── ";
  return prefix;
}

export function MemfsTreeViewer({
  agentId,
  entries,
  onClose,
  conversationId,
}: MemfsTreeViewerProps) {
  const terminalWidth = useTerminalWidth();
  const rows = useTerminalRows();
  const treeLines = Math.max(2, Math.min(15, rows - 13));
  const fullLines = Math.max(1, Math.min(16, rows - 10));
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const isTmux = Boolean(process.env.TMUX);
  const isLocalAgent = isLocalAgentId(agentId);
  const adeUrl = isLocalAgent
    ? null
    : buildChatUrl(agentId, { view: "memory", conversationId });

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [treeScrollOffset, setTreeScrollOffset] = useState(0);
  const [viewMode, setViewMode] = useState<"split" | "full">("split");
  const [fullViewScrollOffset, setFullViewScrollOffset] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showStatus(msg: string, durationMs: number) {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatus(msg);
    statusTimerRef.current = setTimeout(() => setStatus(null), durationMs);
  }

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const treeNodes = useMemo(() => remoteTree(entries), [entries]);
  const fileNodes = useMemo(
    () => treeNodes.filter((node) => !node.isDirectory),
    [treeNodes],
  );
  const selectedFile = fileNodes[selectedIndex];
  const selectedContent =
    entries.find((entry) => entry.relative_path === selectedFile?.relativePath)
      ?.content ?? "";
  const contentLines = selectedContent.split("\n");
  const maxFullViewScroll = Math.max(0, contentLines.length - fullLines);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    if (input === "o" || input === "O") {
      showStatus("Opening in browser...", 10000);
      const opened = adeUrl
        ? import("open")
            .then(({ default: open }) => open(adeUrl))
            .then(() => "Opened in browser")
        : import("@/web/generate-memory-viewer")
            .then(({ openSessionMemoryViewer }) =>
              openSessionMemoryViewer(agentId, entries, conversationId),
            )
            .then((result) =>
              result.opened ? "Opened in browser" : result.filePath,
            );
      void opened
        .then((message) => showStatus(message, 3000))
        .catch(() => showStatus("Could not open browser", 3000));
      return;
    }
    if (key.escape) {
      if (viewMode === "full") {
        setViewMode("split");
        setFullViewScrollOffset(0);
      } else {
        onClose();
      }
      return;
    }

    if (viewMode === "split") {
      if (key.upArrow) {
        if (selectedIndex > 0) {
          const newIndex = selectedIndex - 1;
          setSelectedIndex(newIndex);
          const newFile = fileNodes[newIndex];
          if (newFile) {
            const nodeIndex = treeNodes.findIndex(
              (n) => n.relativePath === newFile.relativePath,
            );
            if (nodeIndex >= 0) {
              const desiredOffset = Math.max(0, nodeIndex - 1);
              if (desiredOffset < treeScrollOffset) {
                setTreeScrollOffset(desiredOffset);
              }
            }
          }
        } else if (treeScrollOffset > 0) {
          setTreeScrollOffset(treeScrollOffset - 1);
        }
      } else if (key.downArrow && selectedIndex < fileNodes.length - 1) {
        const newIndex = selectedIndex + 1;
        setSelectedIndex(newIndex);
        const newFile = fileNodes[newIndex];
        if (newFile) {
          const nodeIndex = treeNodes.findIndex(
            (n) => n.relativePath === newFile.relativePath,
          );
          if (nodeIndex >= 0 && nodeIndex >= treeScrollOffset + treeLines) {
            setTreeScrollOffset(nodeIndex - treeLines + 1);
          }
        }
      } else if (key.return) {
        if (selectedFile) {
          setViewMode("full");
          setFullViewScrollOffset(0);
        }
      }
    } else {
      if (key.upArrow) {
        setFullViewScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setFullViewScrollOffset((prev) =>
          Math.min(maxFullViewScroll, prev + 1),
        );
      }
    }
  });

  if (treeNodes.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /memory"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Box marginBottom={1}>
          <Text bold color={colors.selector.title}>
            View your agent's memory
          </Text>
        </Box>
        <Text dimColor>{"  "}No files in memory filesystem.</Text>
        <Box marginTop={1}>
          <Text dimColor>{"  "}Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (viewMode === "full" && selectedFile) {
    const visibleLines = contentLines.slice(
      fullViewScrollOffset,
      fullViewScrollOffset + fullLines,
    );
    const canScrollDown = fullViewScrollOffset < maxFullViewScroll;
    const charCount = selectedContent.length;
    const barColor = colors.selector.itemHighlighted;

    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /memory"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />

        <Box marginBottom={1}>
          <Text bold color={colors.selector.title}>
            {selectedFile.relativePath}
          </Text>
        </Box>

        <Box
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeftColor={barColor}
          paddingLeft={1}
        >
          <Text>{visibleLines.join("\n") || "(empty)"}</Text>
        </Box>

        {canScrollDown ? (
          <Text dimColor>
            {"  "}↓ {maxFullViewScroll - fullViewScrollOffset} more line
            {maxFullViewScroll - fullViewScrollOffset !== 1 ? "s" : ""} below
          </Text>
        ) : maxFullViewScroll > 0 ? (
          <Text> </Text>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {"  "}
            {charCount.toLocaleString()} chars
          </Text>
          {status ? (
            <Text dimColor>
              {"  "}
              {status}
            </Text>
          ) : (
            <Text dimColor>{"  "}↑↓ scroll · O open in browser · Esc back</Text>
          )}
        </Box>
      </Box>
    );
  }

  const leftWidth = Math.floor((terminalWidth - 4) * 0.45);
  const rightWidth = terminalWidth - leftWidth - 4;

  const visibleTreeNodes = treeNodes.slice(
    treeScrollOffset,
    treeScrollOffset + treeLines,
  );

  const previewContentLines = treeLines - 1;
  const previewLines = contentLines.slice(0, previewContentLines);
  const hasMorePreviewLines = contentLines.length > previewContentLines;

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /memory"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />

      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          View your agent's memory
        </Text>
      </Box>

      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>

      <Box flexDirection="row">
        <Box flexDirection="column" width={leftWidth}>
          {visibleTreeNodes.map((node) => {
            const isSelected =
              !node.isDirectory &&
              node.relativePath === selectedFile?.relativePath;
            const prefix = renderTreePrefix(node);
            const isSystemDir = node.isDirectory && node.name === "system/";

            return (
              <Box key={node.relativePath} flexDirection="row">
                <Text
                  backgroundColor={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  color={isSelected ? "white" : undefined}
                >
                  {prefix}
                </Text>
                <Text
                  backgroundColor={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  color={
                    isSelected
                      ? "black"
                      : isSystemDir
                        ? colors.status.success
                        : undefined
                  }
                  dimColor={node.isDirectory && !isSystemDir}
                >
                  {node.name}
                </Text>
              </Box>
            );
          })}

          {visibleTreeNodes.length < treeLines &&
            Array.from({
              length: treeLines - visibleTreeNodes.length,
            }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
              <Text key={`pad-${i}`}> </Text>
            ))}

          {treeScrollOffset + treeLines < treeNodes.length ? (
            <Text dimColor>
              ...{treeNodes.length - treeScrollOffset - treeLines} more
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>

        <Box flexDirection="column" marginLeft={1} marginRight={1}>
          {Array.from({ length: treeLines + 1 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static separator elements
            <Text key={i} dimColor>
              │
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" width={rightWidth}>
          {selectedFile ? (
            <>
              {previewLines.map((line, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: content lines by position
                <Text key={idx}>
                  {line.length > rightWidth - 2
                    ? `${line.slice(0, rightWidth - 5)}...`
                    : line || " "}
                </Text>
              ))}

              {Array.from({
                length: Math.max(
                  0,
                  previewContentLines - previewLines.length + 1,
                ),
              }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}

              {hasMorePreviewLines ? (
                <Text dimColor>
                  ...{contentLines.length - previewContentLines} more (enter to
                  view)
                </Text>
              ) : (
                <Text> </Text>
              )}
            </>
          ) : (
            <>
              <Text dimColor>No file selected</Text>

              {Array.from({ length: treeLines }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}
            </>
          )}
        </Box>
      </Box>

      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>

      <Box flexDirection="column" marginTop={1}>
        {status ? (
          <Text dimColor>
            {"  "}
            {status}
          </Text>
        ) : (
          <Box>
            <Text dimColor>{"  "}↑↓ navigate · Enter view · </Text>
            {adeUrl && !isTmux && (
              <Link url={adeUrl}>
                <Text dimColor>Edit in ADE</Text>
              </Link>
            )}
            {adeUrl && isTmux && <Text dimColor>Edit in ADE: {adeUrl}</Text>}
            {!adeUrl && <Text dimColor>Local agent: {agentId}</Text>}
            <Text dimColor> · O open in browser</Text>
            <Text dimColor> · Esc close</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
