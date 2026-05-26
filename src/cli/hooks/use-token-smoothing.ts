// React hook that returns a smoothed version of a monotonic count.
//
// Raw streaming counts jump in chunk-sized steps which reads as twitchy.
// We catch up to the target on a 50ms tick with a piecewise-linear rule:
//   +3 when close (<70), 15% of the gap when mid-range (<200), capped at
//   +50 when far. Forward-only during active streaming; snaps to the
//   exact target when inactive so post-stream values match the real total.
//
// Defensive: if the target ever decreases mid-stream (no current call path
// does this, but resets are plausible) the displayed value snaps to the new
// target rather than getting stuck at the higher value.

import { useEffect, useRef, useState } from "react";

const TICK_MS = 50;
const CLOSE_THRESHOLD = 70;
const MID_THRESHOLD = 200;
const STEP_WHEN_CLOSE = 3;
const STEP_WHEN_MID_FRACTION = 0.15;
const STEP_WHEN_MID_MIN = 8;
const STEP_WHEN_FAR = 50;

export function useTokenSmoothing(rawCount: number, active: boolean): number {
  const targetRef = useRef(rawCount);
  const displayedRef = useRef(rawCount);
  const [displayed, setDisplayed] = useState(rawCount);

  useEffect(() => {
    targetRef.current = rawCount;
  }, [rawCount]);

  useEffect(() => {
    if (!active) {
      displayedRef.current = targetRef.current;
      setDisplayed(targetRef.current);
      return;
    }
    const id = setInterval(() => {
      const target = targetRef.current;
      const cur = displayedRef.current;
      const delta = target - cur;
      if (delta <= 0) {
        if (cur !== target) {
          displayedRef.current = target;
          setDisplayed(target);
        }
        return;
      }
      let step: number;
      if (delta < CLOSE_THRESHOLD) {
        step = STEP_WHEN_CLOSE;
      } else if (delta < MID_THRESHOLD) {
        step = Math.max(
          STEP_WHEN_MID_MIN,
          Math.ceil(delta * STEP_WHEN_MID_FRACTION),
        );
      } else {
        step = STEP_WHEN_FAR;
      }
      const next = Math.min(cur + step, target);
      displayedRef.current = next;
      setDisplayed(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return displayed;
}
