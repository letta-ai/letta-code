import { memo, useEffect, useState } from "react";
import { Text } from "./Text";

const DEFAULT_GARBAGE_CHARS = "._";
const DEFAULT_TICK_MS = 30;
const DEFAULT_MIN_GARBAGE = 1;
const DEFAULT_MAX_GARBAGE = 2;
const DEFAULT_CURSOR = "█";

function generateGarbage(count: number, chars: string): string {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export interface FanOutAnimationOptions {
  garbageChars?: string;
  tickMs?: number;
  minGarbage?: number;
  maxGarbage?: number;
  cursor?: string;
  showCursorOnComplete?: boolean;
}

export interface FanOutAnimationProps extends FanOutAnimationOptions {
  text: string;
  onComplete?: () => void;
  bold?: boolean;
  dimColor?: boolean;
}

function generateFrames(
  text: string,
  garbageChars: string,
  minGarbage: number,
  maxGarbage: number,
  cursor: string,
): string[] {
  const frames: string[] = [];
  let position = 0;

  frames.push(cursor);

  while (position < text.length) {
    const remaining = text.length - position;
    const range = maxGarbage - minGarbage + 1;
    const count = Math.min(
      Math.floor(Math.random() * range) + minGarbage,
      remaining,
    );

    const revealed = text.slice(0, position);
    const garbage = generateGarbage(count, garbageChars);
    frames.push(`${revealed}${garbage}${cursor}`);

    position += count;
    const newRevealed = text.slice(0, position);
    frames.push(`${newRevealed}${cursor}`);
  }

  frames.push(text);

  return frames;
}

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

  const [frames] = useState(() =>
    generateFrames(text, garbageChars, minGarbage, maxGarbage, cursor),
  );

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

export const CompactingAnimation = memo(() => {
  return <FanOutAnimation text="Compacting..." bold />;
});

CompactingAnimation.displayName = "CompactingAnimation";
