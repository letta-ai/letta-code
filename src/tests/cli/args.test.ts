import { describe, expect, test } from "bun:test";
import {
  CLI_FLAG_CATALOG,
  CLI_OPTIONS,
  getCliFlagsForMode,
  parseCliArgs,
  preprocessCliArgs,
} from "../../cli/args";

describe("shared CLI arg schema", () => {
  test("catalog is the single source of truth for parser mapping and mode support", () => {
    const catalogKeys = Object.keys(CLI_FLAG_CATALOG).sort();
    const optionKeys = Object.keys(CLI_OPTIONS).sort();
    expect(optionKeys).toEqual(catalogKeys);

    const validModes = new Set(["interactive", "headless", "both"]);
    const validTypes = new Set(["boolean", "string"]);

    for (const [flagName, definition] of Object.entries(CLI_FLAG_CATALOG)) {
      expect(validModes.has(definition.mode)).toBe(true);
      expect(validTypes.has(definition.parser.type)).toBe(true);
      expect(CLI_OPTIONS[flagName]).toEqual(definition.parser);
    }
  });

  test("mode lookups include shared flags and exclude opposite-mode-only flags", () => {
    const headlessFlags = getCliFlagsForMode("headless");
    const interactiveFlags = getCliFlagsForMode("interactive");

    expect(headlessFlags).toContain("memfs-startup");
    expect(headlessFlags).not.toContain("resume");
    expect(interactiveFlags).toContain("resume");
    expect(interactiveFlags).not.toContain("memfs-startup");
    expect(headlessFlags).toContain("agent");
    expect(interactiveFlags).toContain("agent");
  });

  test("normalizes --conv alias to --conversation", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs(["node", "script", "--conv", "conv-123", "-p", "hello"]),
      true,
    );
    expect(parsed.values.conversation).toBe("conv-123");
    expect(parsed.positionals.slice(2).join(" ")).toBe("hello");
  });

  test("recognizes headless-specific startup flags in strict mode", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "-p",
        "hello",
        "--memfs-startup",
        "background",
        "--pre-load-skills",
        "skill-a,skill-b",
        "--max-turns",
        "3",
        "--block-value",
        "persona=hello",
      ]),
      true,
    );
    expect(parsed.values["memfs-startup"]).toBe("background");
    expect(parsed.values["pre-load-skills"]).toBe("skill-a,skill-b");
    expect(parsed.values["max-turns"]).toBe("3");
    expect(parsed.values["block-value"]).toEqual(["persona=hello"]);
  });

  test("treats --import argument as a flag value, not prompt text", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "-p",
        "hello",
        "--import",
        "@author/agent",
      ]),
      true,
    );
    expect(parsed.values.import).toBe("@author/agent");
    expect(parsed.positionals.slice(2).join(" ")).toBe("hello");
  });

  test("supports short aliases used by headless and interactive modes", () => {
    const parsed = parseCliArgs(
      preprocessCliArgs([
        "node",
        "script",
        "-p",
        "hello",
        "-c",
        "-C",
        "conv-123",
      ]),
      true,
    );
    expect(parsed.values.continue).toBe(true);
    expect(parsed.values.conversation).toBe("conv-123");
  });
});
