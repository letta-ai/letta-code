import { describe, expect, test } from "bun:test";

import {
  getPlanExitChoices,
  getPlanExitRestoreLabel,
  resolvePlanExitMode,
} from "../../cli/helpers/planExitApproval";

describe("plan exit approval", () => {
  test("choices omit duplicates for default/acceptEdits", () => {
    const defaultChoices = getPlanExitChoices("default").map((c) => c.decision);
    expect(defaultChoices).toEqual(["restore", "autoAccept", "custom"]);

    const acceptChoices = getPlanExitChoices("acceptEdits").map(
      (c) => c.decision,
    );
    expect(acceptChoices).toEqual(["restore", "manual", "custom"]);

    const yoloChoices = getPlanExitChoices("bypassPermissions").map(
      (c) => c.decision,
    );
    expect(yoloChoices).toEqual(["restore", "manual", "autoAccept", "custom"]);
  });

  test("restore labels are explicit about the mode being restored", () => {
    expect(getPlanExitRestoreLabel("bypassPermissions")).toBe(
      "Yes, and return to yolo mode",
    );
    expect(getPlanExitRestoreLabel("acceptEdits")).toBe(
      "Yes, and return to auto-accept edits",
    );
    expect(getPlanExitRestoreLabel("default")).toBe(
      "Yes, and return to manual approvals",
    );
    expect(getPlanExitChoices("bypassPermissions")[0]?.label).toBe(
      "Yes, and return to yolo mode",
    );
  });

  test("exit mode resolution", () => {
    expect(resolvePlanExitMode("restore", "bypassPermissions")).toBe(
      "bypassPermissions",
    );
    expect(resolvePlanExitMode("restore", null)).toBe("default");

    expect(resolvePlanExitMode("manual", "bypassPermissions")).toBe("default");
    expect(resolvePlanExitMode("manual", "acceptEdits")).toBe("default");

    expect(resolvePlanExitMode("autoAccept", "default")).toBe("acceptEdits");
    expect(resolvePlanExitMode("autoAccept", "bypassPermissions")).toBe(
      "acceptEdits",
    );
  });
});
