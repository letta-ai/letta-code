import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
