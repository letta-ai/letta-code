import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

  test("rejects absolute paths", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    const absolutePath = join(testDir.path, "abs.txt");

    await expect(
      apply_patch({
        input: `*** Begin Patch
*** Add File: ${absolutePath}
+hello
*** End Patch`,
      }),
    ).rejects.toThrow(/must be relative/);
  });

  test("fails when adding an existing file", async () => {
    testDir = new TestDirectory();
    originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = testDir.path;

    testDir.createFile("exists.txt", "original");

    await expect(
      apply_patch({
        input: `*** Begin Patch
*** Add File: exists.txt
+new
*** End Patch`,
      }),
    ).rejects.toThrow(/already exists/);
  });
});
