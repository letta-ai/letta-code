import { memo, useState } from "react";
import stringWidth from "string-width";
import { colors } from "@/cli/components/colors.js";
import { Text } from "@/cli/components/Text";
import { useAnimation } from "@/cli/contexts/AnimationContext.js";
import {
  BRAILLE_ANIMATIONS,
  type BrailleAnimationKey,
  STREAMING_STATUS_ANIMATION_KEYS,
} from "./animations.js";
import { useFrameCycle } from "./use-frame-cycle.js";

interface StreamingStatusSpinnerProps {
  color?: string;
  /**
   * Override the randomly-picked animation. Primarily for tests; leave
   * unset in production so streams get a random pick on mount.
   */
  animation?: BrailleAnimationKey;
  /** Target cell width; the frame is centered and space-padded. */
  width?: number;
  marginRight?: number;
}

function pickRandomAnimationKey(): BrailleAnimationKey {
  const pool = STREAMING_STATUS_ANIMATION_KEYS;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? pool[0] ?? "orbit";
}

/**
 * Spinner for the streaming-status row of the chat input.
 *
 * On mount, picks one animation at random from
 * {@link STREAMING_STATUS_ANIMATION_KEYS} and cycles its frames via
 * {@link useFrameCycle}. Honors the global `AnimationContext` — when
 * animations are disabled, the first frame is held static.
 *
 * Replaces the previous `<Spinner type="layer" />` from `ink-spinner`
 * at the streaming-status site; that dependency is retained for other
 * call sites (e.g. `ListenerStatusUI`).
 */
export const StreamingStatusSpinner = memo(
  ({
    color = colors.status.processing,
    animation,
    width = 1,
    marginRight = 0,
  }: StreamingStatusSpinnerProps) => {
    const { shouldAnimate } = useAnimation();
    const [animationKey] = useState<BrailleAnimationKey>(
      () => animation ?? pickRandomAnimationKey(),
    );
    const { frames, intervalMs } = BRAILLE_ANIMATIONS[animationKey];

    const frameIndex = useFrameCycle(frames, intervalMs, shouldAnimate);
    const frame = frames[frameIndex] ?? frames[0] ?? "·";

    const frameWidth = stringWidth(frame);
    const targetWidth = Math.max(1, width);
    const totalPadding = Math.max(0, targetWidth - frameWidth);
    const leftPadding = Math.floor(totalPadding / 2);
    const rightPadding = totalPadding - leftPadding;
    const paddedFrame =
      " ".repeat(leftPadding) + frame + " ".repeat(rightPadding);

    const output = paddedFrame + " ".repeat(Math.max(0, marginRight));

    return <Text color={color}>{output}</Text>;
  },
);

StreamingStatusSpinner.displayName = "StreamingStatusSpinner";
