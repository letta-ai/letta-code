import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchFiles } from "../cli/helpers/fileSearch";

const TEST_DIR = join(process.cwd(), ".test-filesearch");

beforeEach(() => {
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
});

afterEach(() => {
  // Clean up test directory
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("searchFiles finds files in current directory (shallow)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("", false);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.path === "README.md")).toBe(true);
  expect(results.some((r) => r.path === "package.json")).toBe(true);
});

test("searchFiles filters by pattern (shallow)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("README", false);

  process.chdir(originalCwd);

  expect(results.length).toBe(1);
  expect(results[0]?.path).toBe("README.md");
  expect(results[0]?.type).toBe("file");
});

test("searchFiles finds files recursively (deep)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("App", true);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.path.includes("App.tsx"))).toBe(true);
});

test("searchFiles finds files in subdirectories (deep)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("Button", true);

  process.chdir(originalCwd);

  expect(results.length).toBe(1);
  // Use platform-agnostic path check
  expect(results[0]?.path).toContain("components");
  expect(results[0]?.path).toContain("Button.tsx");
  expect(results[0]?.type).toBe("file");
});

test("searchFiles identifies directories correctly", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("", false);

  process.chdir(originalCwd);

  const srcDir = results.find((r) => r.path === "src");
  expect(srcDir).toBeDefined();
  expect(srcDir?.type).toBe("dir");
});

test("searchFiles returns empty array for non-existent pattern", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("nonexistent12345", true);

  process.chdir(originalCwd);

  expect(results.length).toBe(0);
});

test("searchFiles case-insensitive matching", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("readme", false);

  process.chdir(originalCwd);

  expect(results.length).toBe(1);
  expect(results[0]?.path).toBe("README.md");
});

test("searchFiles skips node_modules (deep)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  // Create node_modules directory
  mkdirSync(join(TEST_DIR, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(TEST_DIR, "node_modules/pkg/index.js"), "module");

  const results = await searchFiles("index", true);

  process.chdir(originalCwd);

  // Should find index.ts but not node_modules/pkg/index.js
  expect(results.some((r) => r.path.includes("node_modules"))).toBe(false);
  expect(results.some((r) => r.path.includes("index.ts"))).toBe(true);
});

test("searchFiles handles relative path queries", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  const results = await searchFiles("src/A", false);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThanOrEqual(1);
  // Check that at least one result contains App.tsx
  expect(results.some((r) => r.path.includes("App.tsx"))).toBe(true);
});

test("searchFiles supports partial path matching (deep)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  // Search for "components/Button" should match "src/components/Button.tsx"
  const results = await searchFiles("components/Button", true);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results.some((r) => r.path.includes("components/Button.tsx"))).toBe(
    true,
  );
});

test("searchFiles supports partial directory path matching (deep)", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  // Search for "src/components" should match the directory
  const results = await searchFiles("src/components", true);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(
    results.some((r) => r.path === "src/components" && r.type === "dir"),
  ).toBe(true);
});

test("searchFiles partial path matching works with subdirectories", async () => {
  const originalCwd = process.cwd();
  process.chdir(TEST_DIR);

  // Create nested directory
  mkdirSync(join(TEST_DIR, "ab/cd/ef"), { recursive: true });
  writeFileSync(join(TEST_DIR, "ab/cd/ef/test.txt"), "test");

  // Search for "cd/ef" should match "ab/cd/ef"
  const results = await searchFiles("cd/ef", true);

  process.chdir(originalCwd);

  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results.some((r) => r.path.includes("cd/ef"))).toBe(true);
});
