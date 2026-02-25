import { describe, expect, test } from "bun:test";
import { parseCliArgs, preprocessCliArgs } from "../../cli/args";

describe("shared CLI arg schema", () => {
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
