import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import {
  addEntriesToCache,
  refreshFileIndex,
  searchFileIndex,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";

const TEST_DIR = join(process.cwd(), ".test-fileindex");
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  rmSync(TEST_DIR, { recursive: true, force: true });

  // Build a small workspace:
  //   .test-fileindex/
  //     src/
  //       components/
  //         Button.tsx
  //         Input.tsx
  //       index.ts
  //       App.tsx
  //     tests/
  //       app.test.ts
  //     README.md
  //     package.json
  mkdirSync(join(TEST_DIR, "src/components"), { recursive: true });
  mkdirSync(join(TEST_DIR, "tests"), { recursive: true });

  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  writeFileSync(join(TEST_DIR, "package.json"), "{}");
  writeFileSync(join(TEST_DIR, "src/index.ts"), "export {}");
  writeFileSync(join(TEST_DIR, "src/App.tsx"), "export default App");
  writeFileSync(join(TEST_DIR, "src/components/Button.tsx"), "export Button");
  writeFileSync(join(TEST_DIR, "src/components/Input.tsx"), "export Input");
  writeFileSync(join(TEST_DIR, "tests/app.test.ts"), "test()");

  // Provide a .lettaignore so the file index respects exclusions.
  // .letta itself is listed so this directory doesn't affect entry counts.
  mkdirSync(join(TEST_DIR, ".letta"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, ".letta", ".lettaignore"),
    "node_modules\n.git\nvenv\n.venv\n__pycache__\ndist\nbuild\n.letta\n",
    "utf-8",
  );

  setIndexRoot(TEST_DIR);
});

afterEach(() => {
  setIndexRoot(originalCwd);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Build & search basics
// ---------------------------------------------------------------------------

describe("build and search", () => {
  test("indexes all files and directories", async () => {
    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 100,
    });

    // Diagnostic: print entries on CI failure so we can debug Windows issues.
    if (all.length < 10) {
      console.warn(
        `[DIAGNOSTIC] Expected 10 entries but got ${all.length}:`,
        JSON.stringify(all.map((e) => ({ path: e.path, type: e.type }))),
      );
    }

    // Should find all files
    const paths = all.map((r) => r.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths).toContain(join("src", "index.ts"));
    expect(paths).toContain(join("src", "App.tsx"));
    expect(paths).toContain(join("src", "components", "Button.tsx"));
    expect(paths).toContain(join("tests", "app.test.ts"));

    // Should find directories
    expect(paths).toContain("src");
    expect(paths).toContain(join("src", "components"));
    expect(paths).toContain("tests");
  });

  test("assigns correct types", async () => {
    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 100,
    });

    const byPath = new Map(all.map((r) => [r.path, r]));

    expect(byPath.get("src")?.type).toBe("dir");
    expect(byPath.get("tests")?.type).toBe("dir");
    expect(byPath.get(join("src", "components"))?.type).toBe("dir");
    expect(byPath.get("README.md")?.type).toBe("file");
    expect(byPath.get(join("src", "index.ts"))?.type).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// Search filtering
// ---------------------------------------------------------------------------

describe("search filtering", () => {
  test("pattern matching is case-insensitive", async () => {
    await refreshFileIndex();

    const results = searchFileIndex({
      searchDir: "",
      pattern: "readme",
      deep: true,
      maxResults: 100,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe("README.md");
  });

  test("empty pattern returns all entries", async () => {
    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 1000,
    });

    // 3 dirs + 7 files = 10
    expect(all.length).toBe(10);
  });

  test("maxResults is respected", async () => {
    await refreshFileIndex();

    const limited = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 3,
    });

    expect(limited.length).toBe(3);
  });

  test("searchDir scopes to subdirectory", async () => {
    await refreshFileIndex();

    const results = searchFileIndex({
      searchDir: "src",
      pattern: "",
      deep: true,
      maxResults: 100,
    });

    // Everything under src/ (including src itself if it matches)
    for (const r of results) {
      expect(r.path === "src" || r.path.startsWith(`src${join("/")}`)).toBe(
        true,
      );
    }

    // Should NOT include top-level files or tests/
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("tests");
  });

  test("shallow search returns only direct children", async () => {
    await refreshFileIndex();

    const shallow = searchFileIndex({
      searchDir: "src",
      pattern: "",
      deep: false,
      maxResults: 100,
    });

    // Direct children of src: components/, index.ts, App.tsx
    const paths = shallow.map((r) => r.path);
    expect(paths).toContain(join("src", "components"));
    expect(paths).toContain(join("src", "index.ts"));
    expect(paths).toContain(join("src", "App.tsx"));

    // Should NOT include nested children
    expect(paths).not.toContain(join("src", "components", "Button.tsx"));
  });

  test("deep search returns nested children", async () => {
    await refreshFileIndex();

    const deep = searchFileIndex({
      searchDir: "src",
      pattern: "Button",
      deep: true,
      maxResults: 100,
    });

    expect(
      deep.some((r) => r.path === join("src", "components", "Button.tsx")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search result ordering
// ---------------------------------------------------------------------------

describe("result ordering", () => {
  test("directories come before files", async () => {
    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 100,
    });

    const firstFileIdx = all.findIndex((r) => r.type === "file");
    const lastDirIdx = all.reduce(
      (last, r, i) => (r.type === "dir" ? i : last),
      -1,
    );

    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Excluded directories
// ---------------------------------------------------------------------------

describe("exclusions", () => {
  test("node_modules is not indexed", async () => {
    mkdirSync(join(TEST_DIR, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(TEST_DIR, "node_modules/pkg/index.js"), "module");

    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 1000,
    });

    expect(all.some((r) => r.path.includes("node_modules"))).toBe(false);
  });

  test(".git is not indexed", async () => {
    mkdirSync(join(TEST_DIR, ".git/objects"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".git/HEAD"), "ref: refs/heads/main");

    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 1000,
    });

    expect(all.some((r) => r.path.includes(".git"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Incremental rebuild
// ---------------------------------------------------------------------------

describe("incremental rebuild", () => {
  test("detects newly created files", async () => {
    await refreshFileIndex();

    // Create a new file
    writeFileSync(join(TEST_DIR, "NEW_FILE.txt"), "hello");

    await refreshFileIndex();

    const results = searchFileIndex({
      searchDir: "",
      pattern: "NEW_FILE",
      deep: true,
      maxResults: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe("NEW_FILE.txt");
    expect(results[0]?.type).toBe("file");
  });

  test("detects deleted files", async () => {
    await refreshFileIndex();

    // Verify it's there
    let results = searchFileIndex({
      searchDir: "",
      pattern: "README",
      deep: true,
      maxResults: 10,
    });
    expect(results.length).toBe(1);

    // Delete it
    unlinkSync(join(TEST_DIR, "README.md"));

    await refreshFileIndex();

    results = searchFileIndex({
      searchDir: "",
      pattern: "README",
      deep: true,
      maxResults: 10,
    });
    expect(results.length).toBe(0);
  });

  test("detects newly created directories", async () => {
    await refreshFileIndex();

    mkdirSync(join(TEST_DIR, "lib"));
    writeFileSync(join(TEST_DIR, "lib/util.ts"), "export {}");

    await refreshFileIndex();

    const results = searchFileIndex({
      searchDir: "",
      pattern: "lib",
      deep: true,
      maxResults: 10,
    });

    expect(results.some((r) => r.path === "lib" && r.type === "dir")).toBe(
      true,
    );
    expect(
      results.some(
        (r) => r.path === join("lib", "util.ts") && r.type === "file",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addEntriesToCache
// ---------------------------------------------------------------------------

describe("addEntriesToCache", () => {
  test("added entries are found by search", async () => {
    await refreshFileIndex();

    // Simulate a disk scan discovering an external file
    addEntriesToCache([{ path: "external/found.txt", type: "file" }]);

    const results = searchFileIndex({
      searchDir: "",
      pattern: "found.txt",
      deep: true,
      maxResults: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe("external/found.txt");
  });

  test("duplicate paths are not added twice", async () => {
    await refreshFileIndex();

    addEntriesToCache([
      { path: "README.md", type: "file" },
      { path: "README.md", type: "file" },
    ]);

    const results = searchFileIndex({
      searchDir: "",
      pattern: "README",
      deep: true,
      maxResults: 10,
    });

    // Should still be exactly 1 (from the original build)
    expect(results.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Content-based hashing
// ---------------------------------------------------------------------------

/**
 * Replicate the sanitization logic from fileIndex.ts so we can locate the
 * on-disk cache file for a given index root.
 */
function getTestCachePath(indexRoot: string): string {
  const normalizedPath = normalize(indexRoot);
  const strippedPath = normalizedPath.replace(/^[/\\]+/, "");
  const sanitized = strippedPath.replace(/[/\\:]/g, "_").replace(/\s+/g, "_");
  const safeName = sanitized.length === 0 ? "workspace" : sanitized;
  return join(homedir(), ".letta", "projects", safeName, "file-index.json");
}

describe("content-based hashing", () => {
  test("cache file is written with version field", async () => {
    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      // Cache may not be written in CI or when cwd === homedir; skip gracefully
      return;
    }

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.metadata.version).toBe(2);
  });

  test("old cache format (no version) triggers full rebuild", async () => {
    // First build — creates a valid v2 cache
    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      return;
    }

    // Overwrite with a v1-style cache (no version field)
    const oldFormatCache = {
      metadata: { rootHash: "stale-hash" },
      entries: [],
      merkle: {},
      stats: {},
    };
    writeFileSync(cachePath, JSON.stringify(oldFormatCache), "utf-8");

    // Rebuild — should discard the v1 cache and produce a full index
    await refreshFileIndex();

    const all = searchFileIndex({
      searchDir: "",
      pattern: "",
      deep: true,
      maxResults: 1000,
    });

    // All 10 entries (3 dirs + 7 files) should be present despite the stale cache
    expect(all.length).toBe(10);

    // Cache should now be v2 again
    if (existsSync(cachePath)) {
      const newCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(newCache.metadata.version).toBe(2);
    }
  });

  test("modified file content is reflected after rebuild", async () => {
    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    let rootHashBefore: string | undefined;
    if (existsSync(cachePath)) {
      rootHashBefore = JSON.parse(readFileSync(cachePath, "utf-8")).metadata
        .rootHash;
    }

    // Modify file content (content-based hash should change)
    writeFileSync(join(TEST_DIR, "README.md"), "# Changed content");

    await refreshFileIndex();

    // The file should still be in the index
    const results = searchFileIndex({
      searchDir: "",
      pattern: "README",
      deep: true,
      maxResults: 10,
    });
    expect(results.length).toBe(1);

    // If we can read the cache, the root hash should have changed
    if (existsSync(cachePath) && rootHashBefore) {
      const rootHashAfter = JSON.parse(readFileSync(cachePath, "utf-8"))
        .metadata.rootHash;
      expect(rootHashAfter).not.toBe(rootHashBefore);
    }
  });

  test("small file uses content-based hash (sha256 of bytes)", async () => {
    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      return;
    }

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));

    // Compute the expected content hash for README.md
    const fileContent = readFileSync(join(TEST_DIR, "README.md"));
    const expectedHash = createHash("sha256").update(fileContent).digest("hex");

    // The merkle hash stored for this file should match sha256(file_bytes)
    expect(cache.merkle["README.md"]).toBe(expectedHash);
  });

  test("large file falls back to metadata-based hash", async () => {
    // Create a file just over the 5MB threshold
    const largeBuf = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
    writeFileSync(join(TEST_DIR, "large.bin"), largeBuf);

    await refreshFileIndex();

    // File should be indexed and searchable
    const results = searchFileIndex({
      searchDir: "",
      pattern: "large.bin",
      deep: true,
      maxResults: 10,
    });
    expect(results.length).toBe(1);
    expect(results[0]?.type).toBe("file");

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      return;
    }

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    const storedHash = cache.merkle["large.bin"];

    // The hash should NOT be sha256(file_bytes) — it should be a metadata hash
    const contentHash = createHash("sha256").update(largeBuf).digest("hex");
    expect(storedHash).not.toBe(contentHash);
    // Sanity check: it IS a valid hex hash (64 chars for sha256)
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("deep content change propagates through Merkle hashes", async () => {
    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      return;
    }

    const cacheBefore = JSON.parse(readFileSync(cachePath, "utf-8"));
    const rootHashBefore = cacheBefore.metadata.rootHash;
    const srcHashBefore = cacheBefore.merkle["src"];
    const componentsHashBefore = cacheBefore.merkle[join("src", "components")];
    const buttonHashBefore =
      cacheBefore.merkle[join("src", "components", "Button.tsx")];
    // A sibling directory that should NOT change
    const testsHashBefore = cacheBefore.merkle["tests"];

    // Modify a deeply nested file (2 levels deep) without adding/removing files
    writeFileSync(
      join(TEST_DIR, "src/components/Button.tsx"),
      "export function Button() { return <button>Updated</button> }",
    );

    await refreshFileIndex();

    const cacheAfter = JSON.parse(readFileSync(cachePath, "utf-8"));

    // The modified file's hash should change
    expect(cacheAfter.merkle[join("src", "components", "Button.tsx")]).not.toBe(
      buttonHashBefore,
    );

    // Parent directory hashes should propagate the change upward
    expect(cacheAfter.merkle[join("src", "components")]).not.toBe(
      componentsHashBefore,
    );
    expect(cacheAfter.merkle["src"]).not.toBe(srcHashBefore);
    expect(cacheAfter.metadata.rootHash).not.toBe(rootHashBefore);

    // Unrelated sibling subtree should remain unchanged
    expect(cacheAfter.merkle["tests"]).toBe(testsHashBefore);
  });

  test("files with identical content produce the same hash", async () => {
    // Create two files at different paths with identical content
    const sharedContent = "identical content for hash comparison";
    writeFileSync(join(TEST_DIR, "src", "copy-a.ts"), sharedContent);
    writeFileSync(join(TEST_DIR, "tests", "copy-b.ts"), sharedContent);

    await refreshFileIndex();

    const cachePath = getTestCachePath(TEST_DIR);
    if (!existsSync(cachePath)) {
      return;
    }

    const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      merkle: Record<string, string>;
      entries: { path: string }[];
    };

    // Diagnostic: if the new files aren't in the cache, log available keys.
    const copyAKey = join("src", "copy-a.ts");
    const copyBKey = join("tests", "copy-b.ts");
    if (!cache.merkle[copyAKey]) {
      const entryPaths = cache.entries.map((e) => e.path);
      console.warn(
        `[DIAGNOSTIC] merkle key "${copyAKey}" not found.`,
        `\nEntry paths in cache: ${JSON.stringify(entryPaths)}`,
        `\nMerkle keys: ${JSON.stringify(Object.keys(cache.merkle))}`,
      );
    }

    const hashA = cache.merkle[copyAKey];
    const hashB = cache.merkle[copyBKey];

    // Content-based hashing: same bytes → same hash, regardless of path
    expect(hashA).toBe(hashB);

    // And it should equal sha256 of the raw content
    const expectedHash = createHash("sha256")
      .update(Buffer.from(sharedContent))
      .digest("hex");
    expect(hashA).toBe(expectedHash);
  });
});
