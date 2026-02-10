import { memo, useEffect, useState } from "react";
import { useAnimation } from "../contexts/AnimationContext.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

/**
 * A blinking dot indicator for running/pending states.
 * Toggles visibility every 400ms to create a blinking effect.
 *
 * Animation is automatically disabled when:
 * - The AnimationContext's shouldAnimate is false (overflow detected)
 * - The shouldAnimate prop is explicitly set to false (local override)
 *
 * This prevents Ink's clearTerminal flicker when content exceeds viewport.
 */
export const BlinkDot = memo(
  ({
    color = colors.tool.pending,
    symbol = "●",
    shouldAnimate: shouldAnimateProp,
  }: {
    color?: string;
    symbol?: string;
    /** Optional override. If not provided, uses AnimationContext. */
    shouldAnimate?: boolean;
  }) => {
    const { shouldAnimate: shouldAnimateContext } = useAnimation();

    // Prop takes precedence if explicitly set to false, otherwise use context
    const shouldAnimate =
      shouldAnimateProp === false ? false : shouldAnimateContext;

    const [on, setOn] = useState(true);
    useEffect(() => {
      if (!shouldAnimate) return; // Skip interval when animation disabled
      const t = setInterval(() => setOn((v) => !v), 400);
      return () => clearInterval(t);
    }, [shouldAnimate]);
    // Always show symbol when animation disabled (static indicator)
    return <Text color={color}>{on || !shouldAnimate ? symbol : " "}</Text>;
  },
);

BlinkDot.displayName = "BlinkDot";
