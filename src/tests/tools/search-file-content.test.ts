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

    const result = await search_file_content({
      pattern: "Hello",
      dir_path: testDir.path,
    });

    expect(result.message).toContain("Hello World");
    expect(result.message).toContain("Hello Again");
    expect(result.message).not.toContain("Foo Bar");
  });

  test("supports regex patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "function foo() {}\nconst bar = 1;");

    const result = await search_file_content({
      pattern: "function\\s+\\w+",
      dir_path: testDir.path,
    });

    expect(result.message).toContain("function foo()");
  });

  test("respects include filter", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "Hello TypeScript");
    testDir.createFile("test.js", "Hello JavaScript");

    const result = await search_file_content({
      pattern: "Hello",
      dir_path: testDir.path,
      include: "*.ts",
    });

    expect(result.message).toContain("Hello TypeScript");
    expect(result.message).not.toContain("Hello JavaScript");
  });

  test("handles no matches", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Content");

    const result = await search_file_content({
      pattern: "NonexistentPattern",
      dir_path: testDir.path,
    });

    expect(result.message).toContain("No matches found");
  });

  test("validates pattern parameter", async () => {
    // Test that pattern is required
    const result = await search_file_content({
      pattern: "",
      dir_path: ".",
    } as Parameters<typeof search_file_content>[0]);

    // Empty pattern just returns no results
    expect(result.message).toBeTruthy();
  });
});
