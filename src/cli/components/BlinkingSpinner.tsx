import { memo, useEffect, useState } from "react";
import stringWidth from "string-width";
import { useAnimation } from "../contexts/AnimationContext.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/**
 * Frame-based spinner for lightweight status indicators in the TUI.
 */
export const BlinkingSpinner = memo(
  ({
    color = colors.tool.pending,
    frames = BRAILLE_SPINNER_FRAMES,
    intervalMs = 90,
    pulse = true,
    pulseIntervalMs = 300,
    width = 1,
    marginRight = 0,
    shouldAnimate: shouldAnimateProp,
  }: {
    color?: string;
    frames?: readonly string[];
    intervalMs?: number;
    pulse?: boolean;
    pulseIntervalMs?: number;
    width?: number;
    marginRight?: number;
    shouldAnimate?: boolean;
  }) => {
    const { shouldAnimate: shouldAnimateContext } = useAnimation();
    const shouldAnimate =
      shouldAnimateProp === false ? false : shouldAnimateContext;

    const [frameIndex, setFrameIndex] = useState(0);
    const [blinkOn, setBlinkOn] = useState(true);

    useEffect(() => {
      if (!shouldAnimate || frames.length === 0) return;

      const timer = setInterval(() => {
        setFrameIndex((v) => (v + 1) % frames.length);
      }, intervalMs);

      return () => clearInterval(timer);
    }, [shouldAnimate, frames, intervalMs]);

    useEffect(() => {
      if (!shouldAnimate || !pulse) return;

      const timer = setInterval(() => {
        setBlinkOn((v) => !v);
      }, pulseIntervalMs);

      return () => clearInterval(timer);
    }, [shouldAnimate, pulse, pulseIntervalMs]);

    const frame =
      frames.length > 0
        ? shouldAnimate
          ? (frames[frameIndex] ?? frames[0] ?? "·")
          : (frames[0] ?? "·")
        : "·";

    const frameWidth = stringWidth(frame);
    const targetWidth = Math.max(1, width);
    const totalPadding = Math.max(0, targetWidth - frameWidth);
    const leftPadding = Math.floor(totalPadding / 2);
    const rightPadding = totalPadding - leftPadding;
    const paddedFrame =
      " ".repeat(leftPadding) + frame + " ".repeat(rightPadding);

    const output = paddedFrame + " ".repeat(Math.max(0, marginRight));

    return (
      <Text color={color} dimColor={pulse && !blinkOn}>
        {output}
      </Text>
    );
  },
);

BlinkingSpinner.displayName = "BlinkingSpinner";
