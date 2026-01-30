import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { getBuddy, type BuddyState } from "./buddies";
import { colors } from "./colors";

interface BuddyProps {
  name: string;
  state: BuddyState;
}

/**
 * Animated ASCII buddy that responds to app state
 */
export function Buddy({ name, state }: BuddyProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  const buddy = useMemo(() => getBuddy(name), [name]);
  const stateAnimation = buddy?.states[state];

  // Reset frame index when state changes
  useEffect(() => {
    setFrameIndex(0);
  }, [state]);

  // Animate through frames
  useEffect(() => {
    if (!stateAnimation || stateAnimation.frames.length <= 1) {
      return;
    }

    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % stateAnimation.frames.length);
    }, stateAnimation.interval);

    return () => clearInterval(timer);
  }, [stateAnimation]);

  if (!buddy || !stateAnimation) {
    return null;
  }

  const currentFrame = stateAnimation.frames[frameIndex] ?? stateAnimation.frames[0];
  const lines = currentFrame?.split("\n") ?? [];

  // Choose color based on state
  const color = useMemo(() => {
    switch (state) {
      case "thinking":
        return colors.status.processing;
      case "success":
        return colors.status.success;
      case "error":
        return colors.status.error;
      case "waiting":
        return colors.tool.pending;
      default:
        return colors.welcome.accent;
    }
  }, [state]);

  return (
    <Box flexDirection="column" alignItems="flex-end">
      {lines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Animation frames are static
        <Text key={idx} color={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
