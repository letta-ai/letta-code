import { Text } from "ink";
import { memo, useEffect, useState } from "react";
import { colors } from "./colors.js";

/**
 * A blinking dot indicator for running/pending states.
 * Toggles visibility every 400ms to create a blinking effect.
 *
 * @param shouldAnimate - When false, shows static dot (no blinking).
 *   Used to disable animation when content overflows viewport to prevent
 *   Ink's clearTerminal flicker on every render cycle.
 */
export const BlinkDot = memo(
  ({
    color = colors.tool.pending,
    symbol = "●",
    shouldAnimate = true,
  }: {
    color?: string;
    symbol?: string;
    shouldAnimate?: boolean;
  }) => {
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
