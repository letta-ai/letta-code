import { describe, expect, test } from "bun:test";
import { formatReflectionSettings } from "@/cli/app/reflection";

describe("formatReflectionSettings", () => {
  test("includes the reflection merge policy", () => {
    expect(
      formatReflectionSettings({
        trigger: "compaction-event",
        stepCount: 25,
        merge: "explicit",
      }),
    ).toBe("On compaction, agent reviews before applying");
    expect(formatReflectionSettings({ trigger: "off", stepCount: 25 })).toBe(
      "Off, apply automatically",
    );
    expect(
      formatReflectionSettings({
        trigger: "step-count",
        stepCount: 10,
        merge: "auto",
      }),
    ).toBe("Every 10 steps, apply automatically");
  });
});
