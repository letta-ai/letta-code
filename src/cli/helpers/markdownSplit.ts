// src/cli/helpers/markdownSplit.ts
// Markdown-aware content splitting for aggressive static promotion.
// Ported from Gemini CLI: packages/cli/src/ui/utils/markdownUtilities.ts

/**
 * Checks if a given character index is inside a fenced code block (```).
 * Counts fence markers before the index - odd count means inside a block.
 * Only counts ``` at the start of a line (real markdown fences), not ones
 * embedded in code like: content.indexOf("```")
 */
function isIndexInsideCodeBlock(content: string, indexToTest: number): boolean {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf("```", searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    // Only count as fence if at start of content or after a newline
    if (nextFence === 0 || content[nextFence - 1] === "\n") {
      fenceCount++;
    }
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
}

/**
 * Finds the next fence marker (``` at start of line) starting from pos.
 * Returns -1 if not found.
 */
function findNextLineFence(content: string, startPos: number): number {
  let pos = startPos;
  while (pos < content.length) {
    const nextFence = content.indexOf("```", pos);
    if (nextFence === -1) return -1;
    // Only count as fence if at start of content or after a newline
    if (nextFence === 0 || content[nextFence - 1] === "\n") {
      return nextFence;
    }
    pos = nextFence + 3;
  }
  return -1;
}

/**
 * Finds the starting index of the code block that encloses the given index.
 * Returns -1 if the index is not inside a code block.
 */
function findEnclosingCodeBlockStart(content: string, index: number): number {
  if (!isIndexInsideCodeBlock(content, index)) {
    return -1;
  }
  let currentSearchPos = 0;
  while (currentSearchPos < index) {
    const blockStartIndex = findNextLineFence(content, currentSearchPos);
    if (blockStartIndex === -1 || blockStartIndex >= index) {
      break;
    }
    const blockEndIndex = findNextLineFence(content, blockStartIndex + 3);
    if (blockStartIndex < index) {
      if (blockEndIndex === -1 || index < blockEndIndex + 3) {
        return blockStartIndex;
      }
    }
    if (blockEndIndex === -1) break;
    currentSearchPos = blockEndIndex + 3;
  }
  return -1;
}

// Minimum content length before we consider splitting
// This prevents creating many tiny chunks which causes spacing issues
// Higher value = fewer splits = cleaner output but more content re-rendering
const MIN_SPLIT_LENGTH = 1500;

/**
 * Finds the last safe split point in content (paragraph boundary not inside code block).
 * Returns content.length if no safe split point found (meaning don't split).
 *
 * Used for aggressive static promotion during streaming - completed paragraphs
 * can be committed to Ink's <Static> component to reduce flicker.
 */
export function findLastSafeSplitPoint(content: string): number {
  // Don't split if content is too short - prevents excessive chunking
  if (content.length < MIN_SPLIT_LENGTH) {
    return content.length;
  }
  // If end of content is inside a code block, split before that block
  const enclosingBlockStart = findEnclosingCodeBlockStart(
    content,
    content.length,
  );
  if (enclosingBlockStart !== -1) {
    return enclosingBlockStart;
  }

  // Search for the last double newline (\n\n) not in a code block
  let searchStartIndex = content.length;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf("\n\n", searchStartIndex);
    if (dnlIndex === -1) {
      break;
    }

    const potentialSplitPoint = dnlIndex + 2; // Split AFTER the \n\n
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }

    searchStartIndex = dnlIndex - 1;
  }

  // No safe split point found - don't split
  return content.length;
}
