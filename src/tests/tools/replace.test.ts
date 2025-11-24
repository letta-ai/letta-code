import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { replace } from "../../tools/impl/ReplaceGemini";
import { TestDirectory } from "../helpers/testFs";

describe("Replace tool (Gemini)", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("replaces text in existing file", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.createFile("test.txt", "Hello World");

    await replace({
      file_path: filePath,
      old_string: "World",
      new_string: "Universe",
    });

    expect(readFileSync(filePath, "utf-8")).toBe("Hello Universe");
  });

  test("replaces multiple occurrences when expected_replacements > 1", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.createFile("test.txt", "foo bar foo baz");

    await replace({
      file_path: filePath,
      old_string: "foo",
      new_string: "qux",
      expected_replacements: 2,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("qux bar qux baz");
  });

  test("creates new file when old_string is empty", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.resolve("new.txt");

    await replace({
      file_path: filePath,
      old_string: "",
      new_string: "New content",
    });

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("New content");
  });

  test("throws error when file not found with non-empty old_string", async () => {
    testDir = new TestDirectory();
    const nonexistent = testDir.resolve("nonexistent.txt");

    await expect(
      replace({
        file_path: nonexistent,
        old_string: "something",
        new_string: "else",
      }),
    ).rejects.toThrow();
  });

  test("throws error when required parameters are missing", async () => {
    await expect(
      replace({
        file_path: "test.txt",
        old_string: "foo",
      } as Parameters<typeof replace>[0]),
    ).rejects.toThrow(/new_string/);
  });
});
