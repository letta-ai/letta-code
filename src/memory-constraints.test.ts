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
  test("warns instead of failing for problems outside the changed paths", async () => {
    const files: Record<string, string> = {
      "MEMORY.md": "#",
      "big.md": "x".repeat(10),
      "edited.md": "ok",
      "deep/a/b.md": "ok",
    };
    const reader = {
      async listFiles() {
        return Object.keys(files).map((path) => ({ path, mode: "100644" }));
      },
      async readFile(path: string) {
        return new TextEncoder().encode(files[path]);
      },
    };
    const options = {
      layout: "root-marker" as const,
      requireRootMarker: true,
      config: {
        version: 1 as const,
        maxDepth: 1,
        maxFileCharacters: 5,
        maxCoreMemoryCharacters: 12,
      },
    };
    const coreProblem =
      "core memory: 13 characters exceeds 12 from maxCoreMemoryCharacters";
    const problems = [
      "deep/a/b.md: missing required index deep/MEMORY.md",
      "big.md: 10 characters exceeds 5 from maxFileCharacters",
      "deep/a/b.md: depth 2 exceeds maxDepth 1",
      coreProblem,
    ];

    const warnings: string[] = [];
    expect(
      await validateMemoryTreeConstraints(reader, {
        ...options,
        changedPaths: ["notes.txt"],
        warnings,
      }),
    ).toEqual([]);
    expect(warnings).toEqual(problems);

    // Changing a root file can raise the combined budget, so it blocks.
    expect(
      await validateMemoryTreeConstraints(reader, {
        ...options,
        changedPaths: ["edited.md"],
      }),
    ).toEqual([coreProblem]);
    expect(await validateMemoryTreeConstraints(reader, options)).toEqual(
      problems,
    );
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
    ['{"version":1,"readOnlyFiles":["../secret"]}', "repo-relative glob"],
    ['{"version":1,"readOnlyFiles":["a**"]}', "complete path segment"],
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
  /** Resolves the per-file limit for each path under one uncapped glob override
   * and returns the paths that stayed on the 1-character default cap. */
  async function cappedPaths(
    pattern: string,
    paths: string[],
  ): Promise<string[]> {
    const errors = await validateMemoryTreeConstraints(
      {
        async listFiles() {
          return paths.map((path) => ({ path, mode: "100644" }));
        },
        async readFile() {
          throw new Error("countCharacters must be preferred when provided");
        },
        async countCharacters() {
          return 3;
        },
      },
      {
        layout: "shared-memory",
        requireRootMarker: false,
        config: {
          version: 1,
          maxFileCharacters: 1,
          fileCharacterLimits: [{ pattern, maxCharacters: null }],
        },
      },
    );
    return errors.map((error) => error.split(":")[0] ?? error);
  }

  test.each([
    ["*.md", ["notes.md", "reference/notes.md"], ["reference/notes.md"]],
    [
      "reference/**/*.md",
      ["reference/api.md", "reference/a/b/deep.md", "system/api.md"],
      ["system/api.md"],
    ],
    [
      "**/MEMORY.md",
      ["MEMORY.md", "reference/MEMORY.md", "MEMORY-x.md"],
      ["MEMORY-x.md"],
    ],
    ["v?.md", ["v1.md", "v10.md", "v/.md"], ["v10.md", "v/.md"]],
    ["a.b.md", ["a.b.md", "aXb.md"], ["aXb.md"]],
  ])(
    "resolves glob override %s with path-segment semantics",
    async (pattern, paths, expectedCapped) => {
      expect(await cappedPaths(pattern, paths)).toEqual(expectedCapped);
    },
  );

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
