import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_NAME } from "@/constants";
import {
  allocateSubagentName,
  createSubagentNameAllocator,
  resolveCreatedAgentName,
  SUBAGENT_NAMES,
} from "./names";

describe("subagent name allocation", () => {
  test("draws all 101 distinct names before starting another round", () => {
    const allocate = createSubagentNameAllocator(() => 0);
    const names = Array.from({ length: 101 }, allocate);
    expect(new Set(SUBAGENT_NAMES).size).toBe(101);
    expect(new Set(names).size).toBe(101);
    expect(names.map((name) => name.replace(" (subagent)", ""))).toEqual([
      ...SUBAGENT_NAMES,
    ]);
    expect(allocate()).toBe("Deckard the 2nd (subagent)");
  });

  test("uses the random choice among names that remain, rather than retrying duplicates", () => {
    const allocate = createSubagentNameAllocator(() => 0.999999);
    expect(allocate()).toBe("Pepe (subagent)");
    expect(allocate()).toBe("Garry (subagent)");
    const rest = Array.from({ length: 99 }, allocate);
    expect(new Set(rest).size).toBe(99);
    expect(rest).not.toContain("Pepe (subagent)");
    expect(rest).not.toContain("Garry (subagent)");
  });

  test("keeps names distinct across exhausted pools, including teen ordinals", () => {
    const allocate = createSubagentNameAllocator(() => 0);
    const names = Array.from({ length: 101 * 23 }, allocate);
    expect(new Set(names).size).toBe(names.length);
    for (const [round, ordinal] of [
      [3, "3rd"],
      [11, "11th"],
      [12, "12th"],
      [13, "13th"],
      [21, "21st"],
      [22, "22nd"],
      [23, "23rd"],
    ] as const) {
      expect(names[(round - 1) * 101]).toBe(
        `Deckard the ${ordinal} (subagent)`,
      );
    }
  });

  test("a fresh process pool starts independently", () => {
    const first = createSubagentNameAllocator(() => 0);
    const second = createSubagentNameAllocator(() => 0);
    expect(first()).toBe(second());
    first();
    expect(second()).toBe("Rachael (subagent)");
  });

  test("interleaved callers share the process allocator without collisions", async () => {
    const names = await Promise.all(
      Array.from({ length: 101 }, async () => {
        await Promise.resolve();
        return allocateSubagentName();
      }),
    );
    expect(new Set(names).size).toBe(101);
  });
});

describe("new agent name selection", () => {
  test("uses the parent's reservation without drawing again in the child", () => {
    expect(resolveCreatedAgentName(undefined, true, "Joi (subagent)")).toBe(
      "Joi (subagent)",
    );
  });

  test("standalone subagent creation also receives a generated name", () => {
    const first = resolveCreatedAgentName(undefined, true);
    const second = resolveCreatedAgentName(undefined, true);
    expect(first).toEndWith(" (subagent)");
    expect(second).toEndWith(" (subagent)");
    expect(first).not.toBe(second);
  });

  test("explicit names win for both regular agents and subagents", () => {
    for (const subagent of [true, false]) {
      expect(
        resolveCreatedAgentName("My agent", subagent, "Joi (subagent)"),
      ).toBe("My agent");
    }
  });

  test("regular agent creation ignores a subagent reservation", () => {
    expect(resolveCreatedAgentName(undefined, false, "Joi (subagent)")).toBe(
      DEFAULT_AGENT_NAME,
    );
  });
});
