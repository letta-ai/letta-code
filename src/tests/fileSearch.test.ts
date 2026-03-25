import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setIndexRoot } from "../cli/helpers/fileIndex";
import { searchFiles } from "../cli/helpers/fileSearch";

const isWindows = process.platform === "win32";
const TEST_DIR = join(process.cwd(), ".test-filesearch");
let originalRoot: string;

beforeEach(() => {
  originalRoot = process.cwd();
  // Create test directory structure
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "src/components"), { recursive: true });
  mkdirSync(join(TEST_DIR, "tests"), { recursive: true });

  // Create test files
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  writeFileSync(join(TEST_DIR, "package.json"), "{}");
  writeFileSync(join(TEST_DIR, "src/index.ts"), "console.log('test')");
  writeFileSync(join(TEST_DIR, "src/App.tsx"), "export default App");
  writeFileSync(join(TEST_DIR, "src/components/Button.tsx"), "export Button");
  writeFileSync(join(TEST_DIR, "tests/app.test.ts"), "test()");

  // Provide a .lettaignore so exclusions work when the cwd is changed to TEST_DIR.
  mkdirSync(join(TEST_DIR, ".letta"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, ".letta", ".lettaignore"),
    "node_modules\nvenv\n.venv\n__pycache__\n.letta\n",
    "utf-8",
  );
});

afterEach(() => {
  // Clean up test directory
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("searchFiles finds files in current directory (shallow)", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("", false);

  setIndexRoot(originalRoot);

  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.path === "README.md")).toBe(true);
  expect(results.some((r) => r.path === "package.json")).toBe(true);
});

test("searchFiles filters by pattern (shallow)", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("README", false);

  setIndexRoot(originalRoot);

  expect(results.length).toBe(1);
  expect(results[0]?.path).toBe("README.md");
  expect(results[0]?.type).toBe("file");
});

test("searchFiles finds files recursively (deep)", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("App", true);

  setIndexRoot(originalRoot);

  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.path.includes("App.tsx"))).toBe(true);
});

test("searchFiles finds files in subdirectories (deep)", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("Button", true);

  setIndexRoot(originalRoot);

  expect(results.length).toBe(1);
  // Use platform-agnostic path check
  expect(results[0]?.path).toContain("components");
  expect(results[0]?.path).toContain("Button.tsx");
  expect(results[0]?.type).toBe("file");
});

test("searchFiles identifies directories correctly", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("", false);

  setIndexRoot(originalRoot);

  const srcDir = results.find((r) => r.path === "src");
  expect(srcDir).toBeDefined();
  expect(srcDir?.type).toBe("dir");
});

test("searchFiles returns empty array for non-existent pattern", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("nonexistent12345", true);

  setIndexRoot(originalRoot);

  expect(results.length).toBe(0);
});

test("searchFiles case-insensitive matching", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("readme", false);

  setIndexRoot(originalRoot);

  expect(results.length).toBe(1);
  expect(results[0]?.path).toBe("README.md");
});

test("searchFiles skips node_modules (deep)", async () => {
  setIndexRoot(TEST_DIR);

  // Create node_modules directory
  mkdirSync(join(TEST_DIR, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(TEST_DIR, "node_modules/pkg/index.js"), "module");

  const results = await searchFiles("index", true);

  setIndexRoot(originalRoot);

  // Should find index.ts but not node_modules/pkg/index.js
  expect(results.some((r) => r.path.includes("node_modules"))).toBe(false);
  expect(results.some((r) => r.path.includes("index.ts"))).toBe(true);
});

test("searchFiles skips venv directories (deep)", async () => {
  setIndexRoot(TEST_DIR);

  // Create venv directory (Python virtual environment)
  mkdirSync(join(TEST_DIR, "venv/lib"), { recursive: true });
  writeFileSync(join(TEST_DIR, "venv/lib/module.py"), "# python");

  // Also test .venv (common alternative)
  mkdirSync(join(TEST_DIR, ".venv/lib"), { recursive: true });
  writeFileSync(join(TEST_DIR, ".venv/lib/other.py"), "# python");

  const results = await searchFiles("module", true);

  setIndexRoot(originalRoot);

  // Should not find files in venv or .venv
  expect(results.some((r) => r.path.includes("venv"))).toBe(false);
  expect(results.some((r) => r.path.includes(".venv"))).toBe(false);
});

test("searchFiles skips excluded directories in shallow search", async () => {
  setIndexRoot(TEST_DIR);

  // Create excluded directories
  mkdirSync(join(TEST_DIR, "node_modules"), { recursive: true });
  mkdirSync(join(TEST_DIR, "venv"), { recursive: true });
  mkdirSync(join(TEST_DIR, "__pycache__"), { recursive: true });

  const results = await searchFiles("", false);

  setIndexRoot(originalRoot);

  // Should not include excluded directories in shallow search
  expect(results.some((r) => r.path === "node_modules")).toBe(false);
  expect(results.some((r) => r.path === "venv")).toBe(false);
  expect(results.some((r) => r.path === "__pycache__")).toBe(false);
  // But should still include non-excluded directories
  expect(results.some((r) => r.path === "src")).toBe(true);
});

test("searchFiles uses case-insensitive exclusion for directory names", async () => {
  setIndexRoot(TEST_DIR);

  // Create directory with different casing (Windows-style)
  // This tests that Node_Modules or NODE_MODULES would be excluded
  mkdirSync(join(TEST_DIR, "Node_Modules/pkg"), { recursive: true });
  writeFileSync(join(TEST_DIR, "Node_Modules/pkg/test.js"), "module");

  const results = await searchFiles("test", true);

  setIndexRoot(originalRoot);

  // Should not find files in Node_Modules (case-insensitive match to node_modules)
  expect(
    results.some((r) => r.path.toLowerCase().includes("node_modules")),
  ).toBe(false);
});

test("searchFiles handles relative path queries", async () => {
  setIndexRoot(TEST_DIR);

  const results = await searchFiles("src/A", false);

  setIndexRoot(originalRoot);

  expect(results.length).toBeGreaterThanOrEqual(1);
  // Check that at least one result contains App.tsx
  expect(results.some((r) => r.path.includes("App.tsx"))).toBe(true);
});

test.skipIf(isWindows)(
  "searchFiles supports partial path matching (deep)",
  async () => {
    setIndexRoot(TEST_DIR);

    // Search for "components/Button" should match "src/components/Button.tsx"
    const results = await searchFiles("components/Button", true);

    setIndexRoot(originalRoot);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.path.includes("components/Button.tsx"))).toBe(
      true,
    );
  },
);

test.skipIf(isWindows)(
  "searchFiles supports partial directory path matching (deep)",
  async () => {
    setIndexRoot(TEST_DIR);

    // Search for "src/components" should match the directory
    const results = await searchFiles("src/components", true);

    setIndexRoot(originalRoot);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(
      results.some((r) => r.path === "src/components" && r.type === "dir"),
    ).toBe(true);
  },
);

test.skipIf(isWindows)(
  "searchFiles partial path matching works with subdirectories",
  async () => {
    setIndexRoot(TEST_DIR);

    // Create nested directory
    mkdirSync(join(TEST_DIR, "ab/cd/ef"), { recursive: true });
    writeFileSync(join(TEST_DIR, "ab/cd/ef/test.txt"), "test");

    // Search for "cd/ef" should match "ab/cd/ef"
    const results = await searchFiles("cd/ef", true);

    setIndexRoot(originalRoot);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.path.includes("cd/ef"))).toBe(true);
  },
);
