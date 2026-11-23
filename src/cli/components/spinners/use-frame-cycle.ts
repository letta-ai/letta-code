import { useEffect, useState } from "react";

export function useFrameCycle(
  frames: readonly string[],
  intervalMs: number,
  enabled: boolean,
): number {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
    if (!enabled || frames.length === 0) return;

    const timer = setInterval(() => {
      setFrameIndex((v) => (v + 1) % frames.length);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [enabled, frames, intervalMs]);

  return enabled ? frameIndex : 0;
}
