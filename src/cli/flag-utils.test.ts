import { describe, expect, test } from "bun:test";
import {
  parseCsvListFlag,
  parsePositiveIntFlag,
  resolveImportFlagAlias,
} from "@/cli/flag-utils";

describe("flag utils", () => {
  test("parseCsvListFlag handles undefined and none", () => {
    expect(parseCsvListFlag(undefined)).toBeUndefined();
    expect(parseCsvListFlag("none")).toEqual([]);
    expect(parseCsvListFlag("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  test("resolveImportFlagAlias prefers --import", () => {
    expect(
      resolveImportFlagAlias({
        importFlagValue: "@author/agent",
        fromAfFlagValue: "path.af",
      }),
    ).toBe("@author/agent");
    expect(
      resolveImportFlagAlias({
        importFlagValue: undefined,
        fromAfFlagValue: "path.af",
      }),
    ).toBe("path.af");
  });

  test("parsePositiveIntFlag accepts complete decimal positive integers", () => {
    expect(
      parsePositiveIntFlag({
        rawValue: undefined,
        flagName: "max-turns",
      }),
    ).toBeUndefined();
    expect(
      parsePositiveIntFlag({
        rawValue: "3",
        flagName: "max-turns",
      }),
    ).toBe(3);
    expect(
      parsePositiveIntFlag({
        rawValue: " 42 ",
        flagName: "max-turns",
      }),
    ).toBe(42);
  });

  test.each(["0", "-1", "1.5", "10junk", " ", "NaN", "9007199254740992"])(
    "parsePositiveIntFlag rejects invalid input %p",
    (rawValue) => {
      expect(() =>
        parsePositiveIntFlag({ rawValue, flagName: "max-turns" }),
      ).toThrow("--max-turns must be a positive integer");
    },
  );

  test("parsePositiveIntFlag enforces an explicit upper bound", () => {
    expect(
      parsePositiveIntFlag({
        rawValue: "1000",
        flagName: "limit",
        maxValue: 1000,
      }),
    ).toBe(1000);
    expect(() =>
      parsePositiveIntFlag({
        rawValue: "1001",
        flagName: "limit",
        maxValue: 1000,
      }),
    ).toThrow("--limit must be an integer between 1 and 1000");
  });
});
