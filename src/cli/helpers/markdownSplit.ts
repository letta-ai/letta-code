// src/cli/helpers/markdownSplit.ts
// Markdown-aware content splitting for aggressive static promotion.
// Ported from Gemini CLI: packages/cli/src/ui/utils/markdownUtilities.ts

/**
 * Checks if a given character index is inside a fenced code block (```).
 * Counts fence markers before the index - odd count means inside a block.
 */
function isIndexInsideCodeBlock(content: string, indexToTest: number): boolean {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf("```", searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    fenceCount++;
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
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
    const blockStartIndex = content.indexOf("```", currentSearchPos);
    if (blockStartIndex === -1 || blockStartIndex >= index) {
      break;
    }
    const blockEndIndex = content.indexOf("```", blockStartIndex + 3);
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

/**
 * Finds the last safe split point in content (paragraph boundary not inside code block).
 * Returns content.length if no safe split point found (meaning don't split).
 *
 * Used for aggressive static promotion during streaming - completed paragraphs
 * can be committed to Ink's <Static> component to reduce flicker.
 */
export function findLastSafeSplitPoint(content: string): number {
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
