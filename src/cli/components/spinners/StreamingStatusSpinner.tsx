import { memo } from "react";
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
   * Explicit animation override. Wins over `tier`. Used by tests and
   * temporary local hardcodes.
   */
  animation?: BrailleAnimationKey;
  /**
   * Context-usage tier (0–3). When set, the spinner picks one animation
   * from `CONTEXT_TIER_ANIMATIONS[tier]`. Ignored if `animation` is
   * provided.
   */
  tier?: number;
  /**
   * Monotonically increasing integer that selects which animation in
   * the pool. The parent bumps it on each new stream so consecutive
   * streams rotate through the pool deterministically (round-robin).
   * Stable within a stream → stable animation within a stream.
   */
  streamSeed?: number;
  /** Target cell width; the frame is centered and space-padded. */
  width?: number;
  marginRight?: number;
}

function pickFromPool(
  pool: readonly BrailleAnimationKey[],
  seed: number,
): BrailleAnimationKey {
  if (pool.length === 0) return "orbit";
  const idx = ((seed % pool.length) + pool.length) % pool.length;
  return pool[idx] ?? pool[0] ?? "orbit";
}

function resolveAnimationKey(
  animation: BrailleAnimationKey | undefined,
  tier: number | undefined,
  seed: number,
): BrailleAnimationKey {
  if (animation) return animation;
  if (tier !== undefined) {
    const clamped = Math.max(
      0,
      Math.min(CONTEXT_TIER_ANIMATIONS.length - 1, tier),
    );
    return pickFromPool(CONTEXT_TIER_ANIMATIONS[clamped] ?? [], seed);
  }
  return pickFromPool(STREAMING_STATUS_ANIMATION_KEYS, seed);
}

/**
 * Spinner for the streaming-status row of the chat input.
 *
 * Selection priority:
 *   1. `animation` prop (explicit override)
 *   2. `tier` + `streamSeed` — `pool[streamSeed % pool.length]`. The
 *      parent increments `streamSeed` on each new stream so consecutive
 *      streams rotate through the tier's pool; mid-stream tier crossings
 *      pick from the new tier's pool at the same seed.
 *   3. Random-ish from the unconstrained 1-cell pool using the seed.
 *
 * Honors the global `AnimationContext` — when animations are disabled,
 * the first frame is held static.
 */
export const StreamingStatusSpinner = memo(
  ({
    color = colors.status.processing,
    animation,
    tier,
    streamSeed = 0,
    width = 1,
    marginRight = 0,
  }: StreamingStatusSpinnerProps) => {
    const { shouldAnimate } = useAnimation();
    const animationKey = resolveAnimationKey(animation, tier, streamSeed);
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
