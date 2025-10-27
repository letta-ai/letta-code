import { afterEach, describe, expect, test } from "bun:test";
import { grep } from "../../tools/impl/Grep";
import { TestDirectory } from "../helpers/testFs";

describe("Grep tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("finds pattern in files (requires ripgrep)", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test1.txt", "Hello World");
    testDir.createFile("test2.txt", "Goodbye World");
    testDir.createFile("test3.txt", "No match here");

    try {
      const result = await grep({
        pattern: "World",
        path: testDir.path,
        output_mode: "files_with_matches",
      });

      expect(result.output).toContain("test1.txt");
      expect(result.output).toContain("test2.txt");
      expect(result.output).not.toContain("test3.txt");
    } catch (error) {
      // Ripgrep might not be available in test environment
      if (error instanceof Error && error.message.includes("ENOENT")) {
        console.log("Skipping grep test - ripgrep not available");
      } else {
        throw error;
      }
    }
  });

  test("case insensitive search with -i flag", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Hello WORLD");

    try {
      const result = await grep({
        pattern: "world",
        path: testDir.path,
        "-i": true,
        output_mode: "content",
      });

      expect(result.output).toContain("WORLD");
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        console.log("Skipping grep test - ripgrep not available");
      } else {
        throw error;
      }
    }
  });

  test("throws error when pattern is missing", async () => {
    await expect(grep({} as any)).rejects.toThrow(
      /missing required parameter.*pattern/,
    );
  });
});
