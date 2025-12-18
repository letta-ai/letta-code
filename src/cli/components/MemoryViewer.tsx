import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { Box, Text, useInput } from "ink";
import Link from "ink-link";
import { useState } from "react";
import { colors } from "./colors";

const PAGE_SIZE = 3; // Show 3 memory blocks per page
const PREVIEW_LINES = 3; // Show 3 lines of content preview
const DETAIL_DESCRIPTION_LINES = 3; // Max lines for description in detail view
const DETAIL_VALUE_LINES = 12; // Visible lines for value content in detail view

interface MemoryViewerProps {
  blocks: Block[];
  agentId: string;
  agentName: string | null;
  onClose: () => void;
}

/**
 * Truncate text to a certain number of lines
 */
function truncateToLines(text: string, maxLines: number): string[] {
  const lines = text.split("\n").slice(0, maxLines);
  return lines;
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

export function MemoryViewer({
  blocks,
  agentId,
  agentName,
  onClose,
}: MemoryViewerProps) {
  // Construct ADE URL for this agent's memory
  const adeUrl = `https://app.letta.com/agents/${agentId}?view=memory`;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  // Detail view state
  const [detailBlockIndex, setDetailBlockIndex] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);

  const totalPages = Math.ceil(blocks.length / PAGE_SIZE);
  const startIndex = currentPage * PAGE_SIZE;
  const visibleBlocks = blocks.slice(startIndex, startIndex + PAGE_SIZE);

  // Navigation within page and across pages
  const navigateUp = () => {
    if (selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    } else if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
      setSelectedIndex(PAGE_SIZE - 1);
    }
  };

  const navigateDown = () => {
    if (selectedIndex < visibleBlocks.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    } else if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
      setSelectedIndex(0);
    }
  };

  // Get the block being viewed in detail
  const detailBlock =
    detailBlockIndex !== null ? blocks[detailBlockIndex] : null;
  const detailValueLines = detailBlock?.value?.split("\n") || [];
  const maxScrollOffset = Math.max(
    0,
    detailValueLines.length - DETAIL_VALUE_LINES,
  );

  useInput((input, key) => {
    // ESC: exit detail view or close entirely
    if (key.escape) {
      if (detailBlockIndex !== null) {
        setDetailBlockIndex(null);
        setScrollOffset(0);
      } else {
        onClose();
      }
      return;
    }

    // Enter: open detail view for selected block
    if (key.return && detailBlockIndex === null) {
      const globalIndex = currentPage * PAGE_SIZE + selectedIndex;
      if (globalIndex < blocks.length) {
        setDetailBlockIndex(globalIndex);
        setScrollOffset(0);
      }
      return;
    }

    // j/k vim-style navigation (list or scroll)
    if (input === "j" || key.downArrow) {
      if (detailBlockIndex !== null) {
        // Scroll down in detail view
        setScrollOffset((prev) => Math.min(prev + 1, maxScrollOffset));
      } else {
        navigateDown();
      }
    } else if (input === "k" || key.upArrow) {
      if (detailBlockIndex !== null) {
        // Scroll up in detail view
        setScrollOffset((prev) => Math.max(prev - 1, 0));
      } else {
        navigateUp();
      }
    }
  });

  if (blocks.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color={colors.selector.title}>
          Memory Blocks
        </Text>
        <Text dimColor>No memory blocks attached to this agent.</Text>
        <Text dimColor>Press ESC to close</Text>
      </Box>
    );
  }

  // Detail view for a single block
  if (detailBlock) {
    const charCount = (detailBlock.value || "").length;
    const descriptionLines = truncateToLines(
      detailBlock.description || "",
      DETAIL_DESCRIPTION_LINES,
    );
    const visibleValueLines = detailValueLines.slice(
      scrollOffset,
      scrollOffset + DETAIL_VALUE_LINES,
    );
    const canScrollUp = scrollOffset > 0;
    const canScrollDown = scrollOffset < maxScrollOffset;
    const barColor = colors.selector.itemHighlighted;

    return (
      <Box flexDirection="column" gap={1}>
        {/* Header */}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text>Viewing the </Text>
            <Text bold color={colors.selector.title}>
              {detailBlock.label}
            </Text>
            <Text> block</Text>
            {detailBlock.read_only && <Text dimColor> (read-only)</Text>}
          </Box>
          <Text dimColor>
            {formatCharCount(charCount, detailBlock.limit ?? null)}
          </Text>
        </Box>
        <Link url={adeUrl}>
          <Text dimColor>View/edit in the ADE</Text>
        </Link>
        <Text dimColor>↑↓/jk to scroll • ESC to go back</Text>

        {/* Description (up to 3 lines) */}
        {descriptionLines.length > 0 && (
          <Box flexDirection="column">
            {descriptionLines.map((line) => (
              <Text key={line.slice(0, 50) || "empty-desc"} dimColor italic>
                {line}
              </Text>
            ))}
          </Box>
        )}

        {/* Scrollable value content */}
        <Box flexDirection="column">
          {/* Scroll up indicator */}
          {canScrollUp && (
            <Text dimColor>
              ↑ {scrollOffset} more line{scrollOffset !== 1 ? "s" : ""} above
            </Text>
          )}

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
            <Text>{visibleValueLines.join("\n")}</Text>
          </Box>

          {/* Scroll down indicator */}
          {canScrollDown && (
            <Text dimColor>
              ↓ {maxScrollOffset - scrollOffset} more line
              {maxScrollOffset - scrollOffset !== 1 ? "s" : ""} below
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={colors.selector.title}>
          Memory Blocks ({blocks.length} attached to {agentName || "agent"})
        </Text>
        {totalPages > 1 && (
          <Text dimColor>
            Page {currentPage + 1}/{totalPages}
          </Text>
        )}
      </Box>
      <Link url={adeUrl}>
        <Text dimColor>View/edit in the ADE</Text>
      </Link>
      <Text dimColor>↑↓/jk to navigate • Enter to view • ESC to close</Text>

      {/* Block list */}
      <Box flexDirection="column" gap={1}>
        {visibleBlocks.map((block, index) => {
          const isSelected = index === selectedIndex;
          const contentLines = truncateToLines(
            block.value || "",
            PREVIEW_LINES,
          );
          const charCount = (block.value || "").length;

          const barColor = isSelected
            ? colors.selector.itemHighlighted
            : colors.command.border;
          const hasEllipsis =
            (block.value || "").split("\n").length > PREVIEW_LINES;

          // Build content preview text
          const previewText = contentLines
            .map((line) =>
              line.length > 80 ? `${line.slice(0, 80)}...` : line,
            )
            .join("\n");

          return (
            <Box
              key={block.id || block.label}
              borderStyle="single"
              borderLeft
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              borderLeftColor={barColor}
              paddingLeft={1}
              flexDirection="column"
            >
              {/* Header row: label + char count */}
              <Box flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row" gap={1}>
                  <Text
                    bold={isSelected}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {block.label}
                  </Text>
                  {block.read_only && <Text dimColor>(read-only)</Text>}
                </Box>
                <Text dimColor>
                  {formatCharCount(charCount, block.limit ?? null)}
                </Text>
              </Box>

              {/* Description (if available) */}
              {block.description && (
                <Text dimColor italic>
                  {block.description.length > 60
                    ? `${block.description.slice(0, 60)}...`
                    : block.description}
                </Text>
              )}

              {/* Content preview */}
              <Text dimColor>{previewText}</Text>

              {/* Ellipsis if content is truncated */}
              {hasEllipsis && <Text dimColor>...</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
