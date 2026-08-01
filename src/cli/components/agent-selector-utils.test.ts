import { describe, expect, test } from "bun:test";
import { formatAgentMemoryBlockCount } from "@/cli/components/agent-selector-utils";

describe("formatAgentMemoryBlockCount", () => {
  test("omits unavailable block counts", () => {
    expect(formatAgentMemoryBlockCount(undefined)).toBeNull();
    expect(formatAgentMemoryBlockCount(null)).toBeNull();
  });

  test("omits zero block counts", () => {
    expect(formatAgentMemoryBlockCount(0)).toBeNull();
  });

  test("formats positive singular and plural block counts", () => {
    expect(formatAgentMemoryBlockCount(1)).toBe("1 memory block");
    expect(formatAgentMemoryBlockCount(2)).toBe("2 memory blocks");
  });
});
