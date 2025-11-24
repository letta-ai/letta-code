import { afterEach, describe, expect, test } from "bun:test";
import { list_directory } from "../../tools/impl/ListDirectoryGemini";
import { TestDirectory } from "../helpers/testFs";

describe("ListDirectory tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("lists files in directory", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file1.txt", "content");
    testDir.createFile("file2.md", "content");

    const result = await list_directory({ dir_path: testDir.path });

    expect(result.message).toContain("file1.txt");
    expect(result.message).toContain("file2.md");
  });

  test("respects ignore patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("keep.txt", "content");
    testDir.createFile("ignore.log", "content");

    const result = await list_directory({
      dir_path: testDir.path,
      ignore: ["*.log"],
    });

    expect(result.message).toContain("keep.txt");
    expect(result.message).not.toContain("ignore.log");
  });

  test("handles empty directory", async () => {
    testDir = new TestDirectory();

    const result = await list_directory({ dir_path: testDir.path });

    // LS tool returns a message about empty directory
    expect(result.message).toContain("empty directory");
  });

  test("throws error for nonexistent directory", async () => {
    testDir = new TestDirectory();
    const nonexistent = testDir.resolve("nonexistent");

    await expect(list_directory({ dir_path: nonexistent })).rejects.toThrow();
  });
});
