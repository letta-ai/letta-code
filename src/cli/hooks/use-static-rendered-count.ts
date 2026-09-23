// src/cli/hooks/use-static-rendered-count.ts
import { useEffect, useRef } from "react";

/**
 * Tracks how many committed static items Ink's <Static> has already rendered.
 * A passive effect runs after Static's layout effect for the same commit, so
 * the count only advances past items that have rendered at full fidelity.
 * Used by transcript payload trimming (helpers/transcript-windowing.ts) to
 * never trim an item before its first full-fidelity render.
 */
export function useStaticRenderedCount(items: readonly unknown[]) {
  const renderedCountRef = useRef(0);
  useEffect(() => {
    renderedCountRef.current = items.length;
  }, [items]);
  return renderedCountRef;
}
