import { afterEach, describe, expect, test } from "bun:test";
import { ls } from "../../tools/impl/LS";
import { TestDirectory } from "../helpers/testFs";

describe("LS tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("lists files and directories", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file1.txt", "");
    testDir.createFile("file2.txt", "");
    testDir.createDir("subdir");

    const result = await ls({ path: testDir.path });

    expect(result.content[0]?.text).toContain("file1.txt");
    expect(result.content[0]?.text).toContain("file2.txt");
    expect(result.content[0]?.text).toContain("subdir/");
  });

  test("shows directories with trailing slash", async () => {
    testDir = new TestDirectory();
    testDir.createDir("folder");
    testDir.createFile("file.txt", "");

    const result = await ls({ path: testDir.path });

    expect(result.content[0]?.text).toContain("folder/");
    expect(result.content[0]?.text).toContain("file.txt");
  });

  test("throws error for non-existent directory", async () => {
    await expect(ls({ path: "/nonexistent/directory" })).rejects.toThrow(
      /Directory not found/,
    );
  });

  test("throws error for file (not directory)", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("notadir.txt", "");

    await expect(ls({ path: file })).rejects.toThrow(/Not a directory/);
  });

  test("throws error when path is missing", async () => {
    await expect(ls({} as Parameters<typeof ls>[0])).rejects.toThrow(
      /missing required parameter.*path/,
    );
  });

  test("filters files using ignore parameter (array)", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file1.txt", "");
    testDir.createFile("file2.log", "");
    testDir.createFile("important.txt", "");
    testDir.createDir("node_modules");

    const result = await ls({
      path: testDir.path,
      ignore: ["*.log", "node_modules"],
    });

    expect(result.content[0]?.text).toContain("file1.txt");
    expect(result.content[0]?.text).toContain("important.txt");
    expect(result.content[0]?.text).not.toContain("file2.log");
    expect(result.content[0]?.text).not.toContain("node_modules");
  });

  test("throws error when ignore is a string instead of array", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file.txt", "");

    await expect(
      ls({
        path: testDir.path,
        ignore: '["*.log", "node_modules"]' as unknown as string[],
      }),
    ).rejects.toThrow(/must be an array/);
  });

  test("throws error when ignore is a number", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file.txt", "");

    await expect(
      ls({
        path: testDir.path,
        ignore: 123 as unknown as string[],
      }),
    ).rejects.toThrow(/must be an array/);
  });

  test("throws error when ignore is an object", async () => {
    testDir = new TestDirectory();
    testDir.createFile("file.txt", "");

    await expect(
      ls({
        path: testDir.path,
        ignore: { pattern: "*.log" } as unknown as string[],
      }),
    ).rejects.toThrow(/must be an array/);
  });
});
