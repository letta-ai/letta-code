import { describe, expect, test } from "bun:test";
import { MEMORY_CONSTRAINTS_CONFIG_PATH as VALIDATOR_CONFIG_PATH } from "@/agent/memory-constraints";
import {
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  MEMORY_CONSTRAINTS_CONFIG_VERSION,
  parseMemoryConstraintsConfig,
  validateMemoryTreeConstraints,
} from "@/memory-constraints";

describe("public memory constraints contract", () => {
  test("validates an externally supplied tree with trusted policy", async () => {
    const errors = await validateMemoryTreeConstraints(
      {
        async listFiles() {
          return [
            { path: "MEMORY.md", mode: "100644" },
            { path: "notes.md", mode: "100644" },
            { path: "reference/link.md", mode: "120000" },
            { path: "skills/example.md", mode: "100644" },
          ];
        },
        async readFile(path) {
          if (path === "MEMORY.md") return new TextEncoder().encode("\uFEFF😀");
          if (path === "notes.md") return new TextEncoder().encode("abc");
          throw new Error(`Should not read excluded or symlink file: ${path}`);
        },
      },
      {
        layout: "root-marker",
        requireRootMarker: true,
        config: { version: 1, maxCoreMemoryCharacters: 4 },
      },
    );
    expect(errors).toEqual([
      "reference/link.md: missing required index reference/MEMORY.md",
      "reference/link.md: memory Markdown must be a regular file",
      "core memory: 5 characters exceeds 4 from maxCoreMemoryCharacters",
    ]);
  });
  test("preserves missing defaults and ordered nullable overrides", () => {
    const policy = {
      version: 1 as const,
      fileCharacterLimits: [
        { pattern: "reference/**", maxCharacters: null },
        { pattern: "*.md", maxCharacters: 12 },
      ],
    };
    expect(parseMemoryConstraintsConfig(JSON.stringify(policy))).toEqual(
      policy,
    );
    expect(parseMemoryConstraintsConfig('{"version":1}')).toEqual({
      version: 1,
    });
  });

  test.each([
    ["null", "expected a JSON object"],
    ['{"version":2}', "version must be 1"],
    ['{"version":1,"unknown":1}', "unknown field 'unknown'"],
    ['{"version":1,"maxDepth":-1}', "maxDepth must be a non-negative integer"],
    [
      '{"version":1,"maxFileCharacters":null}',
      "maxFileCharacters must be a positive integer",
    ],
    [
      '{"version":1,"maxCoreMemoryCharacters":0}',
      "maxCoreMemoryCharacters must be a positive integer",
    ],
    [
      '{"version":1,"fileCharacterLimits":[{"pattern":"x**","maxCharacters":1}]}',
      "'**' must be a complete path segment",
    ],
    [
      '{"version":1,"fileCharacterLimits":[{"pattern":"../x","maxCharacters":1}]}',
      "repo-relative glob",
    ],
    [
      '{"version":1,"fileCharacterLimits":[{"pattern":"x"}]}',
      "maxCharacters must be a positive integer or null",
    ],
  ])("rejects invalid policy %s", (content, message) => {
    expect(() => parseMemoryConstraintsConfig(content)).toThrow(message);
  });
  test("exports the tracked config path used by the validator", () => {
    expect(MEMORY_CONSTRAINTS_CONFIG_PATH).toBe(".memfs.config.json");
    expect(VALIDATOR_CONFIG_PATH).toBe(MEMORY_CONSTRAINTS_CONFIG_PATH);
  });

  test("exports the canonical default policy and serialized file contents", () => {
    expect(DEFAULT_MEMORY_CONSTRAINTS_CONFIG).toEqual({
      version: MEMORY_CONSTRAINTS_CONFIG_VERSION,
      maxDepth: 2,
      maxFileCharacters: 20_000,
      maxCoreMemoryCharacters: 65_536,
    });
    expect(DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT).toBe(
      '{\n  "version": 1,\n  "maxDepth": 2,\n  "maxFileCharacters": 20000,\n  "maxCoreMemoryCharacters": 65536\n}\n',
    );
  });
});
