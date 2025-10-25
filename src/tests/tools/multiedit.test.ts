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
});
