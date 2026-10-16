import { describe, expect, test } from "bun:test";
import { compareSemver } from "./compare-semver.mjs";

describe("compareSemver", () => {
  test.each([
    ["0.34.10", "0.34.9", 1],
    ["0.35.0", "0.34.99", 1],
    ["1.0.0", "0.999.999", 1],
    ["0.34.9", "0.34.10", -1],
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-beta", "1.0.0-alpha.99", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha", 1],
    ["1.0.0+build.2", "1.0.0+build.1", 0],
    ["0.34.10", "0.34.10", 0],
  ])("orders %s against %s", (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected);
  });

  test.each([
    "1",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-alpha.01",
    "1.2.3-",
  ])("rejects invalid version %s", (version) => {
    expect(() => compareSemver(version, "1.2.3")).toThrow(
      "Invalid semantic version",
    );
  });
});
