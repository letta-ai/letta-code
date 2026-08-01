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
    ).toBe("Compaction event, explicit integration");
    expect(formatReflectionSettings({ trigger: "off", stepCount: 25 })).toBe(
      "Off, auto-merge",
    );
  });
});
