import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { Box, Text, useInput } from "ink";
import Link from "ink-link";
import { useEffect, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

const VISIBLE_LINES = 12; // Visible lines for value content

interface MemoryTabViewerProps {
  blocks: Block[];
  agentId: string;
  onClose: () => void;
  conversationId?: string;
}

/**
 * Format character count as "current / limit"
 */
function formatCharCount(current: number, limit: number | null): string {
  if (limit === null || limit === undefined) {
    return `${current.toLocaleString()} chars`;
  }
  return `${current.toLocaleString()} / ${limit.toLocaleString()} chars`;
}

export function MemoryTabViewer({
  blocks,
  agentId,
  onClose,
  conversationId,
}: MemoryTabViewerProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const isTmux = Boolean(process.env.TMUX);
  const adeUrl = `https://app.letta.com/agents/${agentId}?view=memory${conversationId ? `&conversation=${conversationId}` : ""}`;

  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [freshBlocks, setFreshBlocks] = useState<Block[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch fresh memory blocks from the API when component mounts
  useEffect(() => {
    const fetchBlocks = async () => {
      try {
        const client = await getClient();
        const agent = await client.agents.retrieve(agentId, {
          include: ["agent.blocks"],
        });
        setFreshBlocks(agent.memory?.blocks || []);
      } catch (error) {
        console.error("Failed to fetch memory blocks:", error);
        // Fall back to passed-in blocks if fetch fails
        setFreshBlocks(blocks);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBlocks();
  }, [agentId, blocks]);

  // Use fresh blocks if available, otherwise fall back to passed-in blocks
  const displayBlocks = freshBlocks ?? blocks;

  // Get current block
  const currentBlock = displayBlocks[selectedTabIndex];
  const valueLines = currentBlock?.value?.split("\n") || [];
  const maxScrollOffset = Math.max(0, valueLines.length - VISIBLE_LINES);

  // Reset scroll when switching tabs
  const switchTab = (newIndex: number) => {
    setSelectedTabIndex(newIndex);
    setScrollOffset(0);
  };

  useInput((input, key) => {
    // CTRL-C: immediately close
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    // ESC: close
    if (key.escape) {
      onClose();
      return;
    }

    // Tab or left/right to switch tabs
    if (key.tab) {
      const nextIndex = (selectedTabIndex + 1) % displayBlocks.length;
      switchTab(nextIndex);
      return;
    }

    if (key.leftArrow) {
      const prevIndex =
        selectedTabIndex === 0
          ? displayBlocks.length - 1
          : selectedTabIndex - 1;
      switchTab(prevIndex);
      return;
    }

    if (key.rightArrow) {
      const nextIndex = (selectedTabIndex + 1) % displayBlocks.length;
      switchTab(nextIndex);
      return;
    }

    // Up/down to scroll content
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxScrollOffset));
    }
  });

  // Render tab bar (no gap - spacing is handled by padding in each label)
  const renderTabBar = () => (
    <Box flexDirection="row" flexWrap="wrap">
      {displayBlocks.map((block, index) => {
        const isActive = index === selectedTabIndex;
        return (
          <Text
            key={block.id || block.label}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "black" : undefined}
            bold={isActive}
          >
            {` ${block.label} `}
          </Text>
        );
      })}
    </Box>
  );

  // Loading state
  if (isLoading) {
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
        <Text dimColor>{"  "}Loading memory blocks...</Text>
        <Box marginTop={1}>
          <Text dimColor>{"  "}Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // Empty state
  if (displayBlocks.length === 0) {
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
        <Text dimColor>{"  "}No memory blocks attached to this agent.</Text>
        <Box marginTop={1}>
          <Text dimColor>{"  "}Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  const charCount = (currentBlock?.value || "").length;
  const visibleValueLines = valueLines.slice(
    scrollOffset,
    scrollOffset + VISIBLE_LINES,
  );
  const canScrollDown = scrollOffset < maxScrollOffset;
  const barColor = colors.selector.itemHighlighted;

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /memory"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          View your agent's memory
        </Text>
      </Box>

      {/* Tab bar */}
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        {renderTabBar()}
        {currentBlock?.description && (
          <Box width={terminalWidth - 2}>
            <Text dimColor> </Text>
            <MarkdownDisplay text={currentBlock.description} dimColor />
          </Box>
        )}
      </Box>

      {/* Content area */}
      <Box flexDirection="column">
        {/* Value content with left border */}
        <Box
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeftColor={barColor}
          paddingLeft={1}
        >
          <Text>{visibleValueLines.join("\n") || "(empty)"}</Text>
        </Box>

        {/* Scroll down indicator or phantom row */}
        {canScrollDown ? (
          <Text dimColor>
            {"  "}↓ {maxScrollOffset - scrollOffset} more line
            {maxScrollOffset - scrollOffset !== 1 ? "s" : ""} below
          </Text>
        ) : maxScrollOffset > 0 ? (
          <Text> </Text>
        ) : null}
      </Box>

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          {"  "}
          {formatCharCount(charCount, currentBlock?.limit ?? null)}
          {currentBlock?.read_only ? " · read-only" : " · read/write"}
        </Text>
        <Box>
          <Text dimColor>{"  "}←→/Tab switch · ↑↓ scroll · </Text>
          {!isTmux && (
            <Link url={adeUrl}>
              <Text dimColor>Edit in ADE</Text>
            </Link>
          )}
          {isTmux && <Text dimColor>Edit in ADE: {adeUrl}</Text>}
          <Text dimColor> · Esc cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
