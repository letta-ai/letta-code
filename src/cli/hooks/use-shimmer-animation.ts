// React hook that drives the streaming-row shimmer for a given phase.
//
// Returns the current bright-cell offset and base color. The position is
// carried in a ref across phase transitions so a direction or speed change
// continues from wherever the cell currently is, instead of snapping to the
// off-screen edge of the new direction. The overlay color uses phase-local
// time so each phase entry starts at the curve's anchor, not mid-cycle.

import { useEffect, useRef, useState } from "react";
import {
  effectiveBaseColor,
  type PhaseVisual,
} from "@/cli/helpers/phase-visuals";

const SWEEP_TAIL = 10;
const OFFSCREEN = -3;

export type ShimmerAnimation = {
  offset: number;
  baseColor: string;
};

export function useShimmerAnimation({
  active,
  textLength,
  phaseVisual,
}: {
  active: boolean;
  textLength: number;
  phaseVisual: PhaseVisual;
}): ShimmerAnimation {
  const [offset, setOffset] = useState(OFFSCREEN);
  const [baseColor, setBaseColor] = useState<string>(phaseVisual.baseColor);
  const positionRef = useRef<number>(OFFSCREEN);
  const lastFrameRef = useRef<number>(0);
  const phaseStartedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;

    lastFrameRef.current = performance.now();
    phaseStartedAtRef.current = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - lastFrameRef.current;
      lastFrameRef.current = now;

      const minPos = -SWEEP_TAIL;
      const maxPos = textLength + SWEEP_TAIL;
      const cycleLen = maxPos - minPos;

      const dir = phaseVisual.direction === "ltr" ? 1 : -1;
      const raw = positionRef.current + (dt * dir) / phaseVisual.tickMs;
      // Wrap into [minPos, maxPos) so the sweep loops smoothly.
      const wrapped =
        ((((raw - minPos) % cycleLen) + cycleLen) % cycleLen) + minPos;
      positionRef.current = wrapped;

      // For sweepless phases, hide the bright cell off-screen — the breathe
      // overlay alone carries the row's animation. Position still ticks so a
      // later phase that does sweep picks up smoothly from a fresh state.
      const renderedOffset =
        phaseVisual.hasSweep === false ? OFFSCREEN : Math.floor(wrapped);
      setOffset(renderedOffset);
      setBaseColor(
        effectiveBaseColor(phaseVisual, now - phaseStartedAtRef.current),
      );
    };

    tick();
    const id = setInterval(tick, phaseVisual.tickMs);
    return () => clearInterval(id);
  }, [active, textLength, phaseVisual]);

  useEffect(() => {
    if (!active) {
      setOffset(OFFSCREEN);
      setBaseColor(phaseVisual.baseColor);
      positionRef.current = OFFSCREEN;
    }
  }, [active, phaseVisual]);

  return { offset, baseColor };
}
