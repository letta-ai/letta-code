import { Text } from "ink";
import { memo, useEffect, useState } from "react";
import { colors } from "./colors.js";

/**
 * A blinking dot indicator for running/pending states.
 * Toggles visibility every 400ms to create a blinking effect.
 */
export const BlinkDot = memo(
  ({ color = colors.tool.pending }: { color?: string }) => {
    const [on, setOn] = useState(true);
    useEffect(() => {
      const t = setInterval(() => setOn((v) => !v), 400);
      return () => clearInterval(t);
    }, []);
    return <Text color={color}>{on ? "●" : " "}</Text>;
  },
);

BlinkDot.displayName = "BlinkDot";
