import { afterEach, describe, expect, test } from "bun:test";
import { read_many_files } from "../../tools/impl/ReadManyFilesGemini";
import { TestDirectory } from "../helpers/testFs";

describe("ReadManyFiles tool (Gemini)", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("reads multiple files matching pattern", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file1.txt", "Content 1");
    testDir.createFile("file2.txt", "Content 2");
    testDir.createFile("file3.md", "Markdown");

    const result = await read_many_files({ include: ["*.txt"] });

    expect(result.message).toContain("Content 1");
    expect(result.message).toContain("Content 2");
    expect(result.message).not.toContain("Markdown");
  });

  test("concatenates content with separators", async () => {
    testDir = new TestDirectory();
    testDir.createFile("a.txt", "First");
    testDir.createFile("b.txt", "Second");

    const result = await read_many_files({ include: ["*.txt"] });

    expect(result.message).toContain("First");
    expect(result.message).toContain("Second");
    expect(result.message).toContain("---"); // Separator
  });

  test("respects exclude patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("include.txt", "Include me");
    testDir.createFile("exclude.txt", "Exclude me");

    const result = await read_many_files({
      include: ["*.txt"],
      exclude: ["exclude.txt"],
    });

    expect(result.message).toContain("Include me");
    expect(result.message).not.toContain("Exclude me");
  });

  test("handles no matching files", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "content");

    const result = await read_many_files({ include: ["*.nonexistent"] });

    expect(result.message).toContain("No files");
  });

  test("throws error when include is missing", async () => {
    await expect(
      read_many_files({} as Parameters<typeof read_many_files>[0]),
    ).rejects.toThrow(/include/);
  });
});
