import { memo, useEffect, useState } from "react";
import stringWidth from "string-width";
import { colors } from "@/cli/components/colors.js";
import { Text } from "@/cli/components/Text";
import { useAnimation } from "@/cli/contexts/AnimationContext.js";
import {
  BRAILLE_ANIMATIONS,
  type BrailleAnimationKey,
  CONTEXT_TIER_ANIMATIONS,
  STREAMING_STATUS_ANIMATION_KEYS,
} from "./animations.js";
import { useFrameCycle } from "./use-frame-cycle.js";

interface StreamingStatusSpinnerProps {
  color?: string;
  /**
   * Explicit animation override. Wins over `tier`. Used by tests and for
   * temporary local hardcodes.
   */
  animation?: BrailleAnimationKey;
  /**
   * Context-usage tier (0–3). When set, the spinner picks one animation
   * at random from `CONTEXT_TIER_ANIMATIONS[tier]` and re-picks on tier
   * change. Ignored if `animation` is provided.
   */
  tier?: number;
  /** Target cell width; the frame is centered and space-padded. */
  width?: number;
  marginRight?: number;
}

function pickFromPool(
  pool: readonly BrailleAnimationKey[],
): BrailleAnimationKey {
  if (pool.length === 0) return "orbit";
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? pool[0] ?? "orbit";
}

function resolveInitialKey(
  animation: BrailleAnimationKey | undefined,
  tier: number | undefined,
): BrailleAnimationKey {
  if (animation) return animation;
  if (tier !== undefined) {
    const clamped = Math.max(
      0,
      Math.min(CONTEXT_TIER_ANIMATIONS.length - 1, tier),
    );
    return pickFromPool(CONTEXT_TIER_ANIMATIONS[clamped] ?? []);
  }
  return pickFromPool(STREAMING_STATUS_ANIMATION_KEYS);
}

/**
 * Spinner for the streaming-status row of the chat input.
 *
 * Selection priority:
 *   1. `animation` prop (explicit override)
 *   2. `tier` prop — random pick from the tier's pool, re-picked when
 *      the tier changes (so a single stream can grow as context fills)
 *   3. Random from the unconstrained 1-cell pool on mount
 *
 * Honors the global `AnimationContext` — when animations are disabled,
 * the first frame is held static.
 */
export const StreamingStatusSpinner = memo(
  ({
    color = colors.status.processing,
    animation,
    tier,
    width = 1,
    marginRight = 0,
  }: StreamingStatusSpinnerProps) => {
    const { shouldAnimate } = useAnimation();
    const [animationKey, setAnimationKey] = useState<BrailleAnimationKey>(() =>
      resolveInitialKey(animation, tier),
    );

    useEffect(() => {
      if (animation) {
        setAnimationKey(animation);
        return;
      }
      if (tier !== undefined) {
        const clamped = Math.max(
          0,
          Math.min(CONTEXT_TIER_ANIMATIONS.length - 1, tier),
        );
        setAnimationKey(pickFromPool(CONTEXT_TIER_ANIMATIONS[clamped] ?? []));
      }
    }, [animation, tier]);

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
