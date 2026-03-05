import { describe, expect, test } from "bun:test";

import {
  getPlanExitChoices,
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
