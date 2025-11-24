import { afterEach, describe, expect, test } from "bun:test";
import { search_file_content } from "../../tools/impl/SearchFileContentGemini";
import { TestDirectory } from "../helpers/testFs";

describe("SearchFileContent tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("finds pattern in file", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Hello World\nFoo Bar\nHello Again");

    const result = await search_file_content({ pattern: "Hello" });

    expect(result.message).toContain("Hello World");
    expect(result.message).toContain("Hello Again");
    expect(result.message).not.toContain("Foo Bar");
  });

  test("supports regex patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "function foo() {}\nconst bar = 1;");

    const result = await search_file_content({ pattern: "function\\s+\\w+" });

    expect(result.message).toContain("function foo()");
  });

  test("respects include filter", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "Hello TypeScript");
    testDir.createFile("test.js", "Hello JavaScript");

    const result = await search_file_content({
      pattern: "Hello",
      include: "*.ts",
    });

    expect(result.message).toContain("Hello TypeScript");
    expect(result.message).not.toContain("Hello JavaScript");
  });

  test("handles no matches", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Content");

    const result = await search_file_content({ pattern: "NonexistentPattern" });

    expect(result.message).toContain("No matches");
  });

  test("throws error when pattern is missing", async () => {
    await expect(
      search_file_content({} as Parameters<typeof search_file_content>[0]),
    ).rejects.toThrow(/pattern/);
  });
});
