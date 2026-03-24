import { afterEach, describe, expect, test } from "bun:test";
import { search_file_content } from "../../tools/impl/SearchFileContentGemini";
import { executeTool, loadSpecificTools } from "../../tools/manager";
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
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Hello World");

    // Empty pattern matches all lines (valid ripgrep behavior)
    const result = await search_file_content({
      pattern: "",
      dir_path: testDir.path,
    } as Parameters<typeof search_file_content>[0]);

    expect(result.message).toContain("Hello World");
  });

  test("aborts promptly when signal is already aborted", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Hello World");

    const abortController = new AbortController();
    abortController.abort();

    await expect(
      search_file_content({
        pattern: "Hello",
        dir_path: testDir.path,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("manager passes signal through to SearchFileContent execution", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "Hello World");

    await loadSpecificTools(["SearchFileContent"]);

    const abortController = new AbortController();
    abortController.abort();

    const result = await executeTool(
      "SearchFileContent",
      { pattern: "Hello", dir_path: testDir.path },
      { signal: abortController.signal },
    );

    expect(result.status).toBe("error");
    expect(typeof result.toolReturn).toBe("string");
    expect(result.toolReturn).toContain("Interrupted by user");
  });
});
