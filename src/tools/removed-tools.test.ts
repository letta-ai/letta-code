import { describe, expect, test } from "bun:test";
import { findRemovedToolNames } from "@/tools/removed-tools";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";

describe("removed tools", () => {
  test("reports only the removed names, in order", () => {
    expect(
      findRemovedToolNames(["Read", "LS", "mcp__files__read", "MultiEdit"]),
    ).toEqual(["LS", "MultiEdit"]);
    expect(findRemovedToolNames(["Read", "Bash", "TaskStop"])).toEqual([]);
  });

  test("never lists a tool that is still registered", () => {
    expect(findRemovedToolNames(Object.keys(TOOL_DEFINITIONS))).toEqual([]);
  });
});
