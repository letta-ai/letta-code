import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import {
  rebindTurnToolContextMcpOriginator,
  updateToolExecutionContextMcpOriginator,
} from "@/tools/execution-context-mcp-originator";
import { getExecutionContextById } from "@/tools/manager";

const CONTEXTS_KEY = Symbol.for("@letta/toolExecutionContexts");

type MutableContexts = Map<string, { runtimeContext: RuntimeContextSnapshot }>;

function contexts(): MutableContexts {
  const global = globalThis as Record<symbol, MutableContexts | undefined>;
  global[CONTEXTS_KEY] ??= new Map();
  return global[CONTEXTS_KEY] as MutableContexts;
}

describe("updateToolExecutionContextMcpOriginator", () => {
  afterEach(() => {
    contexts().delete("ctx-originator-test");
  });

  test("rebinds a live context's originator id and clears it on null", () => {
    // A parked turn that consumes queued work from another super run keeps
    // executing with its frozen tool context; rebinding is what makes the
    // origin swap a stable boundary for subsequent per-call token lookups
    // (evil-shub r4300657672).
    contexts().set("ctx-originator-test", {
      runtimeContext: { mcpOriginatorSuperRunId: "sr-a" },
    });

    expect(
      updateToolExecutionContextMcpOriginator("ctx-originator-test", "sr-b"),
    ).toBe(true);
    expect(
      getExecutionContextById("ctx-originator-test")?.runtimeContext
        .mcpOriginatorSuperRunId,
    ).toBe("sr-b");

    expect(
      updateToolExecutionContextMcpOriginator("ctx-originator-test", null),
    ).toBe(true);
    expect(
      getExecutionContextById("ctx-originator-test")?.runtimeContext
        .mcpOriginatorSuperRunId,
    ).toBeNull();
  });

  test("returns false for an unknown context id", () => {
    expect(
      updateToolExecutionContextMcpOriginator("ctx-does-not-exist", "sr-b"),
    ).toBe(false);
  });
});

describe("rebindTurnToolContextMcpOriginator", () => {
  afterEach(() => {
    contexts().delete("ctx-originator-test");
  });

  test("no-ops on a missing context id and on an unchanged origin", () => {
    rebindTurnToolContextMcpOriginator(null, "sr-b");
    rebindTurnToolContextMcpOriginator("ctx-originator-test", "sr-b");

    contexts().set("ctx-originator-test", {
      runtimeContext: { mcpOriginatorSuperRunId: "sr-a" },
    });
    const context = getExecutionContextById("ctx-originator-test");
    rebindTurnToolContextMcpOriginator("ctx-originator-test", "sr-a");
    expect(context?.runtimeContext.mcpOriginatorSuperRunId).toBe("sr-a");
  });

  test("swaps the origin and clears it for an unattributed consumed turn", () => {
    contexts().set("ctx-originator-test", {
      runtimeContext: { mcpOriginatorSuperRunId: "sr-a" },
    });
    rebindTurnToolContextMcpOriginator("ctx-originator-test", "sr-b");
    expect(
      getExecutionContextById("ctx-originator-test")?.runtimeContext
        .mcpOriginatorSuperRunId,
    ).toBe("sr-b");
    rebindTurnToolContextMcpOriginator("ctx-originator-test", undefined);
    expect(
      getExecutionContextById("ctx-originator-test")?.runtimeContext
        .mcpOriginatorSuperRunId,
    ).toBeNull();
  });
});
