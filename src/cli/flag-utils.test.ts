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

  test("parsePositiveIntFlag validates positive integers", () => {
    expect(
      parsePositiveIntFlag({
        rawValue: "3",
        flagName: "max-turns",
      }),
    ).toBe(3);
    expect(() =>
      parsePositiveIntFlag({ rawValue: "0", flagName: "max-turns" }),
    ).toThrow("--max-turns must be a positive integer");
  });
});
