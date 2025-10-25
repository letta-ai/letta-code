import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { write } from "../../tools/impl/Write";
import { TestDirectory } from "../helpers/testFs";

describe("Write tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("creates a new file", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.resolve("new.txt");

    await write({ file_path: filePath, content: "Hello, World!" });

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("Hello, World!");
  });

  test("overwrites existing file", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.createFile("existing.txt", "Old content");

    await write({ file_path: filePath, content: "New content" });

    expect(readFileSync(filePath, "utf-8")).toBe("New content");
  });

  test("creates nested directories automatically", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.resolve("nested/deep/file.txt");

    await write({ file_path: filePath, content: "Nested file" });

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("Nested file");
  });

  test("writes UTF-8 content correctly", async () => {
    testDir = new TestDirectory();
    const filePath = testDir.resolve("unicode.txt");
    const content = "Hello 世界 🌍\n╔═══╗";

    await write({ file_path: filePath, content });

    expect(readFileSync(filePath, "utf-8")).toBe(content);
  });
});
