import { describe, expect, test } from "bun:test";
import { getTrajectorySource, listTrajectorySourceTypes } from "./registry";

describe("trajectory source registry", () => {
  test("lists the built-in source types", () => {
    expect(listTrajectorySourceTypes()).toEqual([
      "claude",
      "codex",
      "letta",
      "openhands",
      "transcript",
    ]);
  });

  test("returns a source whose type matches the requested key", () => {
    for (const type of listTrajectorySourceTypes()) {
      expect(getTrajectorySource(type).type).toBe(type);
    }
  });

  test("throws on unknown types, listing the supported ones", () => {
    expect(() => getTrajectorySource("cursor")).toThrow(
      'Unknown trajectory source type "cursor". Supported types: claude, codex, letta, openhands, transcript',
    );
  });
});
