import { Text } from "ink";
import { memo, useEffect, useState } from "react";

// Default configuration
const DEFAULT_GARBAGE_CHARS = "._";
const DEFAULT_TICK_MS = 30;
const DEFAULT_MIN_GARBAGE = 1;
const DEFAULT_MAX_GARBAGE = 2;
const DEFAULT_CURSOR = "█";

// Generate random garbage string
function generateGarbage(count: number, chars: string): string {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export interface FanOutAnimationOptions {
  /** Characters to use for garbage/noise before revealing real chars */
  garbageChars?: string;
  /** Milliseconds between animation frames */
  tickMs?: number;
  /** Minimum garbage characters before each reveal (default 1) */
  minGarbage?: number;
  /** Maximum garbage characters before each reveal (default 2) */
  maxGarbage?: number;
  /** Cursor character shown at the end (default █) */
  cursor?: string;
  /** Whether to show cursor after animation completes */
  showCursorOnComplete?: boolean;
}

export interface FanOutAnimationProps extends FanOutAnimationOptions {
  /** The text to animate */
  text: string;
  /** Called when animation completes */
  onComplete?: () => void;
  /** Text styling */
  bold?: boolean;
  dimColor?: boolean;
}

/**
 * Pre-generate all animation frames at initialization.
 * Follows 3-state cycle:
 * 1. Cursor flush against revealed text (no garbage)
 * 2. Garbage characters appear
 * 3. Garbage replaced with same number of real characters
 */
function generateFrames(
  text: string,
  garbageChars: string,
  minGarbage: number,
  maxGarbage: number,
  cursor: string,
): string[] {
  const frames: string[] = [];
  let position = 0;

  // State 1: Initial frame - just cursor
  frames.push(cursor);

  while (position < text.length) {
    const remaining = text.length - position;
    const range = maxGarbage - minGarbage + 1;
    const count = Math.min(
      Math.floor(Math.random() * range) + minGarbage,
      remaining,
    );

    // State 2: Garbage appears
    const revealed = text.slice(0, position);
    const garbage = generateGarbage(count, garbageChars);
    frames.push(`${revealed}${garbage}${cursor}`);

    // State 3: Garbage replaced with real chars (same count)
    position += count;
    const newRevealed = text.slice(0, position);
    frames.push(`${newRevealed}${cursor}`);
  }

  // Final frame: complete text without cursor
  frames.push(text);

  return frames;
}

/**
 * Hook for fan-out animation logic.
 * Pre-computes all frames, then cycles through with a simple index.
 */
export function useFanOutAnimation(
  text: string,
  options: FanOutAnimationOptions = {},
  onComplete?: () => void,
): { display: string; isComplete: boolean } {
  const {
    garbageChars = DEFAULT_GARBAGE_CHARS,
    tickMs = DEFAULT_TICK_MS,
    minGarbage = DEFAULT_MIN_GARBAGE,
    maxGarbage = DEFAULT_MAX_GARBAGE,
    cursor = DEFAULT_CURSOR,
    showCursorOnComplete = false,
  } = options;

  // Pre-generate frames once on mount
  const [frames] = useState(() =>
    generateFrames(text, garbageChars, minGarbage, maxGarbage, cursor),
  );

  // Simple index state - just increment each tick
  const [frameIndex, setFrameIndex] = useState(0);

  const isComplete = frameIndex >= frames.length - 1;

  useEffect(() => {
    if (isComplete) {
      onComplete?.();
      return;
    }

    const timer = setInterval(() => {
      setFrameIndex((prev) => Math.min(prev + 1, frames.length - 1));
    }, tickMs);

    return () => clearInterval(timer);
  }, [isComplete, frames.length, tickMs, onComplete]);

  const display = frames[frameIndex] ?? text;
  const finalDisplay =
    isComplete && !showCursorOnComplete
      ? text
      : isComplete && showCursorOnComplete
        ? `${text}${cursor}`
        : display;

  return { display: finalDisplay, isComplete };
}

/**
 * Generic fan-out animation component.
 * Characters reveal left-to-right with random garbage chars before each reveal.
 */
export const FanOutAnimation = memo(
  ({
    text,
    onComplete,
    bold = false,
    dimColor = false,
    ...options
  }: FanOutAnimationProps) => {
    const { display } = useFanOutAnimation(text, options, onComplete);

    return (
      <Text bold={bold} dimColor={dimColor} wrap="truncate">
        {display}
      </Text>
    );
  },
);

FanOutAnimation.displayName = "FanOutAnimation";

/**
 * Animated "Compacting..." text with cursor block effect.
 * Convenience wrapper around FanOutAnimation.
 */
export const CompactingAnimation = memo(() => {
  return <FanOutAnimation text="Compacting..." bold />;
});

CompactingAnimation.displayName = "CompactingAnimation";
