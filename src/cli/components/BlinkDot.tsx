import { memo, useEffect, useState } from "react";
import { useAnimation } from "@/cli/contexts/AnimationContext.js";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { colors } from "./colors.js";
import { Text } from "./Text";

export const BlinkDot = memo(
  ({
    color = colors.tool.pending,
    symbol = CLI_GLYPHS.bullet,
    shouldAnimate: shouldAnimateProp,
  }: {
    color?: string;
    symbol?: string;
    shouldAnimate?: boolean;
  }) => {
    const { shouldAnimate: shouldAnimateContext } = useAnimation();

    const shouldAnimate =
      shouldAnimateProp === false ? false : shouldAnimateContext;

    const [on, setOn] = useState(true);
    useEffect(() => {
      if (!shouldAnimate) return;
      const t = setInterval(() => setOn((v) => !v), 400);
      return () => clearInterval(t);
    }, [shouldAnimate]);
    return <Text color={color}>{on || !shouldAnimate ? symbol : " "}</Text>;
  },
);

BlinkDot.displayName = "BlinkDot";
