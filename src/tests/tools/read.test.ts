import { afterEach, describe, expect, test } from "bun:test";
import { read } from "../../tools/impl/Read";
import { TestDirectory } from "../helpers/testFs";

describe("Read tool", () => {
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

    const result = await read({ file_path: file });

    expect(result.content).toContain("Hello, World!");
    expect(result.content).toContain("Line 2");
    expect(result.content).toContain("Line 3");
  });

  test("reads UTF-8 file with Unicode characters", async () => {
    testDir = new TestDirectory();
    const content = "Hello 世界 🌍\n╔═══╗\n║ A ║\n╚═══╝";
    const file = testDir.createFile("unicode.txt", content);

    const result = await read({ file_path: file });

    expect(result.content).toContain("世界");
    expect(result.content).toContain("🌍");
    expect(result.content).toContain("╔═══╗");
  });

  test("formats output with line numbers", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("numbered.txt", "Line 1\nLine 2\nLine 3");

    const result = await read({ file_path: file });

    expect(result.content).toContain("1→Line 1");
    expect(result.content).toContain("2→Line 2");
    expect(result.content).toContain("3→Line 3");
  });

  test("respects offset parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "offset.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    const result = await read({ file_path: file, offset: 2 });

    expect(result.content).not.toContain("Line 1");
    expect(result.content).not.toContain("Line 2");
    expect(result.content).toContain("Line 3");
  });

  test("respects limit parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "limit.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    const result = await read({ file_path: file, limit: 2 });

    expect(result.content).toContain("Line 1");
    expect(result.content).toContain("Line 2");
    expect(result.content).not.toContain("Line 3");
  });

  test("detects binary files and throws error", async () => {
    testDir = new TestDirectory();
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    const file = testDir.createBinaryFile("binary.bin", binaryBuffer);

    await expect(read({ file_path: file })).rejects.toThrow(
      /Cannot read binary file/,
    );
  });

  test("reads TypeScript file with box-drawing characters", async () => {
    testDir = new TestDirectory();
    const tsContent = `// TypeScript file
const box = \`
┌─────────┐
│ Header  │
└─────────┘
\`;
export default box;
`;
    const file = testDir.createFile("ascii-art.ts", tsContent);

    const result = await read({ file_path: file });

    expect(result.content).toContain("┌─────────┐");
    expect(result.content).toContain("│ Header  │");
    expect(result.content).toContain("TypeScript file");
  });

  test("throws error when file_path is missing", async () => {
    await expect(read({} as Parameters<typeof read>[0])).rejects.toThrow(
      /missing required parameter.*file_path/,
    );
  });

  test("returns system reminder for empty files", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("empty.txt", "");

    const result = await read({ file_path: file });

    expect(result.content).toContain("<system-reminder>");
    expect(result.content).toContain("empty contents");
  });

  test("returns system reminder for whitespace-only files", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("whitespace.txt", "   \n\n  \t  ");

    const result = await read({ file_path: file });

    expect(result.content).toContain("<system-reminder>");
    expect(result.content).toContain("empty contents");
  });
});
