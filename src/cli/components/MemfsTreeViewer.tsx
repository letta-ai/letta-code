import { existsSync } from "node:fs";
import { Box, useInput } from "ink";
import Link from "ink-link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { isGitRepo } from "../../agent/memoryGit";
import {
  getFileNodes,
  readFileContent,
  scanMemoryFilesystem,
  type TreeNode,
} from "../../agent/memoryScanner";
import { generateAndOpenMemoryViewer } from "../../web/generate-memory-viewer";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Line characters
const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

// Tree view constants
const TREE_VISIBLE_LINES = 15;
const FULL_VIEW_VISIBLE_LINES = 16;

interface MemfsTreeViewerProps {
  agentId: string;
  agentName?: string;
  onClose: () => void;
  conversationId?: string;
}

/**
 * Render tree line prefix based on depth and parent status
 */
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
  agentName,
  onClose,
  conversationId,
}: MemfsTreeViewerProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const isTmux = Boolean(process.env.TMUX);
  const adeUrl = `https://app.letta.com/agents/${agentId}?view=memory${conversationId && conversationId !== "default" ? `&conversation=${conversationId}` : ""}`;

  // State
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [treeScrollOffset, setTreeScrollOffset] = useState(0);
  const [viewMode, setViewMode] = useState<"split" | "full">("split");
  const [fullViewScrollOffset, setFullViewScrollOffset] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get memory filesystem root
  const memoryRoot = getMemoryFilesystemRoot(agentId);
  const memoryExists = existsSync(memoryRoot);
  const hasGitRepo = useMemo(() => isGitRepo(agentId), [agentId]);

  function showStatus(msg: string, durationMs: number) {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatus(msg);
    statusTimerRef.current = setTimeout(() => setStatus(null), durationMs);
  }

  // Cleanup status timer on unmount
  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  // Scan filesystem and build tree
  const treeNodes = useMemo(
    () => (memoryExists ? scanMemoryFilesystem(memoryRoot) : []),
    [memoryRoot, memoryExists],
  );
  const fileNodes = useMemo(() => getFileNodes(treeNodes), [treeNodes]);

  // Get currently selected file and its content
  const selectedFile = fileNodes[selectedIndex];
  const selectedContent = useMemo(
    () => (selectedFile ? readFileContent(selectedFile.fullPath) : ""),
    [selectedFile],
  );

  // Calculate scroll bounds
  const contentLines = selectedContent.split("\n");
  const maxFullViewScroll = Math.max(
    0,
    contentLines.length - FULL_VIEW_VISIBLE_LINES,
  );

  // Handle input
  useInput((input, key) => {
    // CTRL-C: immediately close
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    // O: open memory viewer in browser (works in both split and full view)
    if ((input === "o" || input === "O") && hasGitRepo) {
      showStatus("Opening in browser...", 10000);
      generateAndOpenMemoryViewer(agentId, { agentName })
        .then(() => showStatus("Opened in browser", 3000))
        .catch((err: unknown) =>
          showStatus(
            err instanceof Error ? err.message : "Failed to open viewer",
            5000,
          ),
        );
      return;
    }

    // ESC: close or return from full view
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
      // Up/down to navigate files
      if (key.upArrow) {
        if (selectedIndex > 0) {
          // Navigate to previous file
          const newIndex = selectedIndex - 1;
          setSelectedIndex(newIndex);
          // Find where this file is in the full tree (including directories)
          const newFile = fileNodes[newIndex];
          if (newFile) {
            const nodeIndex = treeNodes.findIndex(
              (n) => n.relativePath === newFile.relativePath,
            );
            // Scroll up to show the selected node with context
            if (nodeIndex >= 0) {
              const desiredOffset = Math.max(0, nodeIndex - 1);
              if (desiredOffset < treeScrollOffset) {
                setTreeScrollOffset(desiredOffset);
              }
            }
          }
        } else if (treeScrollOffset > 0) {
          // Already at first file, but can still scroll tree up to show context
          setTreeScrollOffset(treeScrollOffset - 1);
        }
      } else if (key.downArrow && selectedIndex < fileNodes.length - 1) {
        const newIndex = selectedIndex + 1;
        setSelectedIndex(newIndex);
        // Find where this file is in the full tree (including directories)
        const newFile = fileNodes[newIndex];
        if (newFile) {
          const nodeIndex = treeNodes.findIndex(
            (n) => n.relativePath === newFile.relativePath,
          );
          // Scroll down if the selected node is below the visible area
          if (
            nodeIndex >= 0 &&
            nodeIndex >= treeScrollOffset + TREE_VISIBLE_LINES
          ) {
            setTreeScrollOffset(nodeIndex - TREE_VISIBLE_LINES + 1);
          }
        }
      } else if (key.return) {
        // Enter to view full file
        if (selectedFile) {
          setViewMode("full");
          setFullViewScrollOffset(0);
        }
      }
    } else {
      // Full view mode - scroll with up/down
      if (key.upArrow) {
        setFullViewScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setFullViewScrollOffset((prev) =>
          Math.min(maxFullViewScroll, prev + 1),
        );
      }
    }
  });

  // No memfs directory
  if (!memoryExists) {
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
        <Text dimColor>
          {"  "}Memory filesystem not found at {memoryRoot}
        </Text>
        <Text dimColor>{"  "}Run /memfs enable to set up.</Text>
        <Box marginTop={1}>
          <Text dimColor>{"  "}Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // Empty state
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

  // Full view mode
  if (viewMode === "full" && selectedFile) {
    const visibleLines = contentLines.slice(
      fullViewScrollOffset,
      fullViewScrollOffset + FULL_VIEW_VISIBLE_LINES,
    );
    const canScrollDown = fullViewScrollOffset < maxFullViewScroll;
    const charCount = selectedContent.length;
    const barColor = colors.selector.itemHighlighted;

    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /memory"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />

        {/* Title with file path */}
        <Box marginBottom={1}>
          <Text bold color={colors.selector.title}>
            {selectedFile.relativePath}
          </Text>
        </Box>

        {/* Content with left border */}
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

        {/* Scroll indicator */}
        {canScrollDown ? (
          <Text dimColor>
            {"  "}↓ {maxFullViewScroll - fullViewScrollOffset} more line
            {maxFullViewScroll - fullViewScrollOffset !== 1 ? "s" : ""} below
          </Text>
        ) : maxFullViewScroll > 0 ? (
          <Text> </Text>
        ) : null}

        {/* Footer */}
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
            <Text dimColor>
              {"  "}↑↓ scroll{hasGitRepo ? " · O open in browser" : ""} · Esc
              back
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // Split view mode
  const leftWidth = Math.floor((terminalWidth - 4) * 0.45);
  const rightWidth = terminalWidth - leftWidth - 4;

  // Visible tree nodes
  const visibleTreeNodes = treeNodes.slice(
    treeScrollOffset,
    treeScrollOffset + TREE_VISIBLE_LINES,
  );

  // Preview content - fills the space
  // Layout: title (1) + content (TREE_VISIBLE_LINES - 1) + more indicator (1) = TREE_VISIBLE_LINES + 1
  // This matches the left panel: tree (TREE_VISIBLE_LINES) + more indicator (1)
  const previewContentLines = TREE_VISIBLE_LINES - 1;
  const previewLines = contentLines.slice(0, previewContentLines);
  const hasMorePreviewLines = contentLines.length > previewContentLines;

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /memory"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          View your agent's memory
        </Text>
      </Box>

      {/* Top dotted border - full width */}
      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>

      {/* Split view */}
      <Box flexDirection="row">
        {/* Left panel - Tree */}
        <Box flexDirection="column" width={leftWidth}>
          {visibleTreeNodes.map((node) => {
            const isSelected =
              !node.isDirectory &&
              node.relativePath === selectedFile?.relativePath;
            const prefix = renderTreePrefix(node);
            // "system/" directory gets special green color
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
          {/* Pad to fixed height */}
          {visibleTreeNodes.length < TREE_VISIBLE_LINES &&
            Array.from({
              length: TREE_VISIBLE_LINES - visibleTreeNodes.length,
            }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
              <Text key={`pad-${i}`}> </Text>
            ))}
          {/* More indicator - always on last row */}
          {treeScrollOffset + TREE_VISIBLE_LINES < treeNodes.length ? (
            <Text dimColor>
              ...{treeNodes.length - treeScrollOffset - TREE_VISIBLE_LINES} more
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>

        {/* Separator */}
        <Box flexDirection="column" marginLeft={1} marginRight={1}>
          {Array.from({ length: TREE_VISIBLE_LINES + 1 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static separator elements
            <Text key={i} dimColor>
              │
            </Text>
          ))}
        </Box>

        {/* Right panel - Preview */}
        <Box flexDirection="column" width={rightWidth}>
          {selectedFile ? (
            <>
              {/* Content lines */}
              {previewLines.map((line, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: content lines by position
                <Text key={idx}>
                  {line.length > rightWidth - 2
                    ? `${line.slice(0, rightWidth - 5)}...`
                    : line || " "}
                </Text>
              ))}
              {/* Padding to fill remaining content space */}
              {Array.from({
                length: Math.max(
                  0,
                  previewContentLines - previewLines.length + 1,
                ),
              }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}
              {/* More indicator */}
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
              {/* Pad to match height */}
              {Array.from({ length: TREE_VISIBLE_LINES }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}
            </>
          )}
        </Box>
      </Box>

      {/* Bottom dotted border - full width */}
      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        {status ? (
          <Text dimColor>
            {"  "}
            {status}
          </Text>
        ) : (
          <Box>
            <Text dimColor>{"  "}↑↓ navigate · Enter view · </Text>
            {!isTmux && (
              <Link url={adeUrl}>
                <Text dimColor>Edit in ADE</Text>
              </Link>
            )}
            {isTmux && <Text dimColor>Edit in ADE: {adeUrl}</Text>}
            {hasGitRepo && <Text dimColor> · O open in browser</Text>}
            <Text dimColor> · Esc close</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
