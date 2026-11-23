function isIndexInsideCodeBlock(content: string, indexToTest: number): boolean {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf("```", searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    if (nextFence === 0 || content[nextFence - 1] === "\n") {
      fenceCount++;
    }
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
}

function findNextLineFence(content: string, startPos: number): number {
  let pos = startPos;
  while (pos < content.length) {
    const nextFence = content.indexOf("```", pos);
    if (nextFence === -1) return -1;
    if (nextFence === 0 || content[nextFence - 1] === "\n") {
      return nextFence;
    }
    pos = nextFence + 3;
  }
  return -1;
}

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

const MIN_SPLIT_LENGTH = 1500;

export function findLastSafeSplitPoint(content: string): number {
  if (content.length < MIN_SPLIT_LENGTH) {
    return content.length;
  }
  const enclosingBlockStart = findEnclosingCodeBlockStart(
    content,
    content.length,
  );
  if (enclosingBlockStart !== -1) {
    return enclosingBlockStart;
  }

  let searchStartIndex = content.length;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf("\n\n", searchStartIndex);
    if (dnlIndex === -1) {
      break;
    }

    const potentialSplitPoint = dnlIndex + 2;
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }

    searchStartIndex = dnlIndex - 1;
  }

  return content.length;
}
