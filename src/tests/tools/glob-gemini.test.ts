import { afterEach, describe, expect, test } from "bun:test";
import { glob_gemini } from "../../tools/impl/GlobGemini";
import { TestDirectory } from "../helpers/testFs";

describe("GlobGemini tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("finds files matching pattern", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "content");
    testDir.createFile("test.js", "content");
    testDir.createFile("README.md", "content");

    const result = await glob_gemini({
      pattern: "*.ts",
      dir_path: testDir.path,
    });

    expect(result.message).toContain("test.ts");
    expect(result.message).not.toContain("test.js");
    expect(result.message).not.toContain("README.md");
  });

  test("supports nested glob patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("src/index.ts", "content");
    testDir.createFile("src/utils.ts", "content");
    testDir.createFile("README.md", "content");

    const result = await glob_gemini({
      pattern: "**/*.ts",
      dir_path: testDir.path,
    });

    // Should find both .ts files regardless of platform path separators
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("index.ts");
    expect(result.message).toContain("utils.ts");
  });

  test("handles no matches", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "content");

    const result = await glob_gemini({
      pattern: "*.nonexistent",
      dir_path: testDir.path,
    });

    expect(result.message).toBe("");
  });

  test("throws error when pattern is missing", async () => {
    await expect(
      glob_gemini({} as Parameters<typeof glob_gemini>[0]),
    ).rejects.toThrow(/pattern/);
  });
});
