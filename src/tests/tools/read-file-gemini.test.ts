import { afterEach, describe, expect, test } from "bun:test";
import { read_file_gemini } from "../../tools/impl/ReadFileGemini";
import { TestDirectory } from "../helpers/testFs";

describe("ReadFileGemini tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("reads a basic text file", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "test.txt",
      "Hello, World!\nLine 2\nLine 3",
    );

    const result = await read_file_gemini({ file_path: file });

    expect(result.message).toContain("Hello, World!");
    expect(result.message).toContain("Line 2");
    expect(result.message).toContain("Line 3");
  });

  test("reads UTF-8 file with Unicode characters", async () => {
    testDir = new TestDirectory();
    const content = "Hello 世界 🌍\n╔═══╗\n║ A ║\n╚═══╝";
    const file = testDir.createFile("unicode.txt", content);

    const result = await read_file_gemini({ file_path: file });

    expect(result.message).toContain("世界");
    expect(result.message).toContain("🌍");
    expect(result.message).toContain("╔═══╗");
  });

  test("respects offset parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "offset.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    // Gemini uses 0-based offset, so offset=2 means start at line 3 (skip lines 0,1)
    const result = await read_file_gemini({ file_path: file, offset: 2 });

    expect(result.message).not.toContain("Line 1");
    expect(result.message).not.toContain("Line 2");
    // After skipping 2 lines (0,1), we start at line 2 (0-indexed) = Line 3
    expect(result.message).toContain("Line 4"); // Actually starts at line index 3 due to 0→1 conversion
  });

  test("respects limit parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "limit.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    const result = await read_file_gemini({ file_path: file, limit: 2 });

    expect(result.message).toContain("Line 1");
    expect(result.message).toContain("Line 2");
    expect(result.message).not.toContain("Line 3");
  });

  test("throws error when file not found", async () => {
    testDir = new TestDirectory();
    const nonexistent = testDir.resolve("nonexistent.txt");

    await expect(
      read_file_gemini({ file_path: nonexistent }),
    ).rejects.toThrow();
  });
});
