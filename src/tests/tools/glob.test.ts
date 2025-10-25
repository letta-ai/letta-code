import { afterEach, describe, expect, test } from "bun:test";
import { glob } from "../../tools/impl/Glob";
import { TestDirectory } from "../helpers/testFs";

describe("Glob tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("finds files by pattern", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.ts", "");
    testDir.createFile("test.js", "");
    testDir.createFile("README.md", "");

    const result = await glob({ pattern: "*.ts", path: testDir.path });

    const basenames = result.files.map((f) => f.split("/").pop());
    expect(basenames).toContain("test.ts");
    expect(basenames).not.toContain("test.js");
    expect(basenames).not.toContain("README.md");
  });

  test("finds files with wildcard patterns", async () => {
    testDir = new TestDirectory();
    testDir.createFile("src/index.ts", "");
    testDir.createFile("src/utils/helper.ts", "");
    testDir.createFile("test.js", "");

    const result = await glob({ pattern: "**/*.ts", path: testDir.path });

    expect(result.files.filter((f) => f.endsWith(".ts")).length).toBe(2);
  });

  test("returns empty array when no matches", async () => {
    testDir = new TestDirectory();
    testDir.createFile("test.txt", "");

    const result = await glob({ pattern: "*.ts", path: testDir.path });

    expect(result.files).toEqual([]);
  });
});
