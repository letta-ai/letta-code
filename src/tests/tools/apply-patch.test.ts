import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply_patch } from "../../tools/impl/ApplyPatch";
import { TestDirectory } from "../helpers/testFs";

describe("apply_patch tool", () => {
  let testDir: TestDirectory | undefined;
  let originalUserCwd: string | undefined;

  afterEach(() => {
    if (originalUserCwd === undefined) delete process.env.USER_CWD;
    else process.env.USER_CWD = originalUserCwd;
    testDir?.cleanup();
    testDir = undefined;
  });

  test("moves file and removes source path", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile("old/name.txt", "old content\n");

    await apply_patch({
      input: `*** Begin Patch
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-old content
+new content
*** End Patch`,
    });

    const oldPath = join(testDir.path, "old/name.txt");
    const newPath = join(testDir.path, "renamed/name.txt");

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf-8")).toBe("new content\n");
  });

  test("accepts absolute paths", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    const absolutePath = join(testDir.path, "abs.txt");

    await apply_patch({
      input: `*** Begin Patch
*** Add File: ${absolutePath}
+hello
*** End Patch`,
    });

    expect(existsSync(absolutePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf-8")).toBe("hello");
  });

  test("overwrites existing file on Add File", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile("exists.txt", "original");

    await apply_patch({
      input: `*** Begin Patch
*** Add File: exists.txt
+new
*** End Patch`,
    });

    const existsPath = join(testDir.path, "exists.txt");
    expect(readFileSync(existsPath, "utf-8")).toBe("new");
  });

  test("fails when deleting a missing file", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    await expect(
      apply_patch({
        input: `*** Begin Patch
*** Delete File: missing.txt
*** End Patch`,
      }),
    ).rejects.toThrow(/Failed to delete file missing.txt/);
  });

  test("allows first update chunk without @@ header", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile("module.py", "import foo\n");

    await apply_patch({
      input: `*** Begin Patch
*** Update File: module.py
 import foo
+bar
*** End Patch`,
    });

    const filePath = join(testDir.path, "module.py");
    expect(readFileSync(filePath, "utf-8")).toBe("import foo\nbar\n");
  });

  test("matches hunks with trailing whitespace tolerance", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    const filePath = join(testDir.path, "whitespace.txt");
    writeFileSync(filePath, "alpha   \nbeta\n", "utf8");

    await apply_patch({
      input: `*** Begin Patch
*** Update File: whitespace.txt
@@
-alpha
+alpha
 beta
*** End Patch`,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("alpha\nbeta\n");
  });

  test("supports lenient heredoc-wrapped patch bodies", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    await apply_patch({
      input: `<<'EOF'
*** Begin Patch
*** Add File: heredoc.txt
+hello
*** End Patch
EOF`,
    });

    const filePath = join(testDir.path, "heredoc.txt");
    expect(readFileSync(filePath, "utf-8")).toBe("hello");
  });

  test("applies context-anchored chunks after @@ marker", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile(
      "context.txt",
      "header\nfunction a\nold\nfunction b\nold\n",
    );

    await apply_patch({
      input: `*** Begin Patch
*** Update File: context.txt
@@ function b
-old
+new
*** End Patch`,
    });

    const filePath = join(testDir.path, "context.txt");
    expect(readFileSync(filePath, "utf-8")).toBe(
      "header\nfunction a\nold\nfunction b\nnew\n",
    );
  });

  test("supports end-of-file hunks with *** End of File marker", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile("eof.txt", "line1\nline2\n");

    await apply_patch({
      input: `*** Begin Patch
*** Update File: eof.txt
@@
-line2
+line2 updated
*** End of File
*** End Patch`,
    });

    const filePath = join(testDir.path, "eof.txt");
    expect(readFileSync(filePath, "utf-8")).toBe("line1\nline2 updated\n");
  });
});
