import { describe, expect, test } from "bun:test";
import type { ParsedCliArgs } from "@/cli/args";
import {
  applyInteractiveReflectionOverrides,
  hasReflectionOverrides,
  parseReflectionOverrides,
} from "@/cli/startup-reflection-settings";

function values(
  input: Partial<ParsedCliArgs["values"]>,
): ParsedCliArgs["values"] {
  return input as ParsedCliArgs["values"];
}

describe("startup reflection settings", () => {
  test("parses startup overrides shared by interactive and headless modes", () => {
    const overrides = parseReflectionOverrides(
      values({
        "reflection-trigger": "off",
        "reflection-step-count": "12",
      }),
    );

    expect(overrides).toEqual({ trigger: "off", stepCount: 12 });
    expect(hasReflectionOverrides(overrides)).toBe(true);
    expect(hasReflectionOverrides(parseReflectionOverrides(values({})))).toBe(
      false,
    );
  });

  test("rejects invalid reflection startup values", () => {
    expect(() =>
      parseReflectionOverrides(values({ "reflection-trigger": "sometimes" })),
    ).toThrow("Valid values: off, step-count, compaction-event");
    expect(() =>
      parseReflectionOverrides(values({ "reflection-step-count": "0" })),
    ).toThrow("Expected a positive integer");
    expect(() =>
      parseReflectionOverrides(values({ "reflection-step-count": "nope" })),
    ).toThrow("Expected a positive integer");
  });

  test("interactive off applies without waiting for MemFS startup", async () => {
    let applied: unknown;
    await applyInteractiveReflectionOverrides(
      "agent-test",
      values({ "reflection-trigger": "off" }),
      new Promise(() => {}),
      async (_agentId, overrides) => {
        applied = overrides;
        return { trigger: "off", stepCount: 25 };
      },
    );

    expect(applied).toEqual({ trigger: "off" });
  });

  test("interactive enabled reflection waits for MemFS startup", async () => {
    const order: string[] = [];
    const memfsReady = Promise.resolve().then(() => {
      order.push("memfs");
    });

    await applyInteractiveReflectionOverrides(
      "agent-test",
      values({ "reflection-trigger": "step-count" }),
      memfsReady,
      async () => {
        order.push("apply");
        return { trigger: "step-count", stepCount: 25 };
      },
    );

    expect(order).toEqual(["memfs", "apply"]);
  });
});
