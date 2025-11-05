import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { multi_edit } from "../../tools/impl/MultiEdit";
import { TestDirectory } from "../helpers/testFs";

describe("MultiEdit tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("applies multiple edits to a file", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "foo bar baz");

    await multi_edit({
      file_path: file,
      edits: [
        { old_string: "foo", new_string: "FOO" },
        { old_string: "bar", new_string: "BAR" },
      ],
    });

    expect(readFileSync(file, "utf-8")).toBe("FOO BAR baz");
  });

  test("applies edits sequentially", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "aaa bbb");

    const result = await multi_edit({
      file_path: file,
      edits: [
        { old_string: "aaa", new_string: "xxx" },
        { old_string: "bbb", new_string: "yyy" },
      ],
    });

    expect(readFileSync(file, "utf-8")).toBe("xxx yyy");
    expect(result.edits_applied).toBe(2);
  });

  test("throws error when file_path is missing", async () => {
    await expect(
      multi_edit({
        edits: [{ old_string: "foo", new_string: "bar" }],
      } as Parameters<typeof multi_edit>[0]),
    ).rejects.toThrow(/missing required parameter.*file_path/);
  });

  test("throws error when edits is missing", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "foo bar");

    await expect(
      multi_edit({
        file_path: file,
      } as Parameters<typeof multi_edit>[0]),
    ).rejects.toThrow(/missing required parameter.*edits/);
  });

  test("throws error when an edit is missing old_string", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "foo bar");

    await expect(
      multi_edit({
        file_path: file,
        edits: [
          { new_string: "bar" } as Parameters<typeof multi_edit>[0]["edits"][0],
        ],
      }),
    ).rejects.toThrow(/missing required parameter.*old_string/);
  });

  test("throws error when an edit is missing new_string", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "foo bar");

    await expect(
      multi_edit({
        file_path: file,
        edits: [
          { old_string: "foo" } as Parameters<typeof multi_edit>[0]["edits"][0],
        ],
      }),
    ).rejects.toThrow(/missing required parameter.*new_string/);
  });

  test("throws error when using typo'd parameter in edit (new_str instead of new_string)", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("test.txt", "foo bar");

    await expect(
      multi_edit({
        file_path: file,
        edits: [
          { old_string: "foo", new_str: "baz" } as unknown as Parameters<
            typeof multi_edit
          >[0]["edits"][0],
        ],
      }),
    ).rejects.toThrow(/missing required parameter.*new_string/);
  });
});
