import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { edit } from "../../tools/impl/Edit";
import { TestDirectory } from "../helpers/testFs";

describe("Edit tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("replaces a simple string", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "Hello, World!");

    const result = await edit({
      file_path: file,
      old_string: "World",
      new_string: "Bun",
    });

    expect(readFileSync(file, "utf-8")).toBe("Hello, Bun!");
    expect(result.replacements).toBe(1);
  });

  test("throws error if old_string not found", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "Hello, World!");

    await expect(
      edit({
        file_path: file,
        old_string: "NotFound",
        new_string: "Something",
      }),
    ).rejects.toThrow(/not found/);
  });

  test("replaces only first occurrence without replace_all", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("duplicate.txt", "foo bar foo baz");

    const result = await edit({
      file_path: file,
      old_string: "foo",
      new_string: "qux",
    });

    expect(readFileSync(file, "utf-8")).toBe("qux bar foo baz");
    expect(result.replacements).toBe(1);
  });

  test("replaces all occurrences with replace_all=true", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("duplicate.txt", "foo bar foo baz foo");

    const result = await edit({
      file_path: file,
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });

    expect(readFileSync(file, "utf-8")).toBe("qux bar qux baz qux");
    expect(result.replacements).toBe(3);
  });

  test("throws error when file_path is missing", async () => {
    await expect(
      edit({
        old_string: "foo",
        new_string: "bar",
      } as Parameters<typeof edit>[0]),
    ).rejects.toThrow(/missing required parameter.*file_path/);
  });

  test("throws error when old_string is missing", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "Hello, World!");

    await expect(
      edit({
        file_path: file,
        new_string: "bar",
      } as Parameters<typeof edit>[0]),
    ).rejects.toThrow(/missing required parameter.*old_string/);
  });

  test("throws error when new_string is missing", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "Hello, World!");

    await expect(
      edit({
        file_path: file,
        old_string: "foo",
      } as Parameters<typeof edit>[0]),
    ).rejects.toThrow(/missing required parameter.*new_string/);
  });

  test("throws error when using typo'd parameter name (new_str instead of new_string)", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "Hello, World!");

    await expect(
      edit({
        file_path: file,
        old_string: "World",
        new_str: "Bun",
      } as unknown as Parameters<typeof edit>[0]),
    ).rejects.toThrow(/missing required parameter.*new_string/);
  });
});
