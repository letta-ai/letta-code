import { describe, expect, test } from "bun:test";
import {
  blendHex,
  effectiveBaseColor,
  getPhaseVisual,
} from "@/cli/helpers/phase-visuals";

describe("phase visuals", () => {
  test("slows the thinking light/dark breathe to a six second cycle", () => {
    const visual = getPhaseVisual("thinking");

    expect(visual.overlayPeriodMs).toBe(6000);
    expect(effectiveBaseColor(visual, 0)).toBe(visual.baseColor.toLowerCase());
    expect(effectiveBaseColor(visual, 1500)).toBe(
      blendHex(visual.baseColor, visual.lighterColor ?? "", 0.85),
    );
    expect(effectiveBaseColor(visual, 3000)).toBe(
      visual.baseColor.toLowerCase(),
    );
    expect(effectiveBaseColor(visual, 4500)).toBe(
      blendHex(visual.baseColor, visual.deeperColor ?? "", 0.85),
    );
  });
});
