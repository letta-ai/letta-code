import { describe, expect, test } from "bun:test";
import { MEMORY_CONSTRAINTS_CONFIG_PATH as VALIDATOR_CONFIG_PATH } from "@/agent/memory-constraints";
import {
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  MEMORY_CONSTRAINTS_CONFIG_VERSION,
} from "@/memory-constraints";

describe("public memory constraints contract", () => {
  test("exports the tracked config path used by the validator", () => {
    expect(MEMORY_CONSTRAINTS_CONFIG_PATH).toBe(".memfs.config.json");
    expect(VALIDATOR_CONFIG_PATH).toBe(MEMORY_CONSTRAINTS_CONFIG_PATH);
  });

  test("exports the canonical default policy and serialized file contents", () => {
    expect(DEFAULT_MEMORY_CONSTRAINTS_CONFIG).toEqual({
      version: MEMORY_CONSTRAINTS_CONFIG_VERSION,
      maxDepth: 2,
      maxFileCharacters: 20_000,
      maxCoreMemoryCharacters: 80_000,
    });
    expect(DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT).toBe(
      '{\n  "version": 1,\n  "maxDepth": 2,\n  "maxFileCharacters": 20000,\n  "maxCoreMemoryCharacters": 80000\n}\n',
    );
  });
});
