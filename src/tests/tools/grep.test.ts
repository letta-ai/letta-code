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
    await expect(grep({} as Parameters<typeof grep>[0])).rejects.toThrow(
      /missing required parameter.*pattern/,
    );
  });

  test("head_limit limits number of results", async () => {
    testDir = new TestDirectory();
    testDir.createFile("a.txt", "match");
    testDir.createFile("b.txt", "match");
    testDir.createFile("c.txt", "match");
    testDir.createFile("d.txt", "match");

    try {
      const result = await grep({
        pattern: "match",
        path: testDir.path,
        output_mode: "files_with_matches",
        head_limit: 2,
      });

      expect(result.files).toBe(4);
      expect(result.output).toContain("showing 2");
      const lines = result.output.split("\n").filter(Boolean);
      expect(lines.length).toBe(3); // header + 2 files
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        console.log("Skipping grep test - ripgrep not available");
      } else {
        throw error;
      }
    }
  });

  test("offset skips initial results", async () => {
    testDir = new TestDirectory();
    testDir.createFile("a.txt", "match");
    testDir.createFile("b.txt", "match");
    testDir.createFile("c.txt", "match");

    try {
      const result = await grep({
        pattern: "match",
        path: testDir.path,
        output_mode: "files_with_matches",
        offset: 1,
      });

      expect(result.files).toBe(3);
      expect(result.output).toContain("showing 2");
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        console.log("Skipping grep test - ripgrep not available");
      } else {
        throw error;
      }
    }
  });

  test("offset and head_limit work together", async () => {
    testDir = new TestDirectory();
    testDir.createFile("a.txt", "match");
    testDir.createFile("b.txt", "match");
    testDir.createFile("c.txt", "match");
    testDir.createFile("d.txt", "match");

    try {
      const result = await grep({
        pattern: "match",
        path: testDir.path,
        output_mode: "files_with_matches",
        offset: 1,
        head_limit: 2,
      });

      expect(result.files).toBe(4);
      expect(result.output).toContain("showing 2");
      const lines = result.output.split("\n").filter(Boolean);
      expect(lines.length).toBe(3); // header + 2 files
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        console.log("Skipping grep test - ripgrep not available");
      } else {
        throw error;
      }
    }
  });
});
