import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { edit, unescapeOverEscapedString } from "../tools/impl/Edit";

describe("unescapeOverEscapedString", () => {
  test("handles normal string without escapes", () => {
    const input = "hello world";
    expect(unescapeOverEscapedString(input)).toBe("hello world");
  });

  test("handles already correct escapes", () => {
    // A string with proper escapes should pass through
    const input = "line1\nline2";
    expect(unescapeOverEscapedString(input)).toBe("line1\nline2");
  });

  test("fixes over-escaped newlines (\\\\n -> \\n)", () => {
    // Input has literal backslash + n that should become newline
    const input = "line1\\nline2";
    expect(unescapeOverEscapedString(input)).toBe("line1\nline2");
  });

  test("fixes over-escaped tabs (\\\\t -> \\t)", () => {
    const input = "col1\\tcol2";
    expect(unescapeOverEscapedString(input)).toBe("col1\tcol2");
  });

  test("fixes over-escaped quotes", () => {
    const input = 'say \\"hello\\"';
    expect(unescapeOverEscapedString(input)).toBe('say "hello"');
  });

  test("fixes over-escaped backticks", () => {
    const input = "template \\`literal\\`";
    expect(unescapeOverEscapedString(input)).toBe("template `literal`");
  });

  test("fixes over-escaped single quotes", () => {
    const input = "it\\'s working";
    expect(unescapeOverEscapedString(input)).toBe("it's working");
  });

  test("fixes over-escaped backslashes before other escapes", () => {
    // \\\\n (double-escaped newline) should become \n
    // In JS: "\\\\n" = the characters \ \ n (two backslashes + n)
    // This represents an over-escaped newline that should become a single newline
    const input = "line1\\\\nline2";
    expect(unescapeOverEscapedString(input)).toBe("line1\nline2");
  });

  test("handles multiple over-escaped sequences", () => {
    const input = "line1\\nline2\\n\\ttabbed\\nwith \\'quotes\\'";
    expect(unescapeOverEscapedString(input)).toBe(
      "line1\nline2\n\ttabbed\nwith 'quotes'",
    );
  });

  test("handles over-escaped backticks in template literals", () => {
    // LLMs often over-escape backticks - we fix those
    const input = "const msg = \\`Hello World\\`;";
    expect(unescapeOverEscapedString(input)).toBe("const msg = `Hello World`;");
  });

  test("preserves \\$ to avoid over-correcting shell/regex contexts", () => {
    // \$ should NOT be unescaped - it's often intentional in shell scripts
    const input = "echo \\$HOME";
    expect(unescapeOverEscapedString(input)).toBe("echo \\$HOME");
  });
});

describe("edit tool", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
    testFile = path.join(tempDir, "test.txt");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("basic replacement works", async () => {
    await fs.writeFile(testFile, "Hello World");

    const result = await edit({
      file_path: testFile,
      old_string: "World",
      new_string: "Universe",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toBe("Hello Universe");
  });

  test("multiline replacement works", async () => {
    const original = `function hello() {
  console.log("Hello");
}`;
    await fs.writeFile(testFile, original);

    const result = await edit({
      file_path: testFile,
      old_string: 'console.log("Hello");',
      new_string: 'console.log("Hello World");',
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toContain('console.log("Hello World");');
  });

  test("falls back to unescaping when direct match fails", async () => {
    // File has actual newlines
    const original = "line1\nline2\nline3";
    await fs.writeFile(testFile, original);

    // LLM provides over-escaped old_string (literal backslash-n)
    // But new_string should be used as-is (not unescaped)
    const result = await edit({
      file_path: testFile,
      old_string: "line1\\nline2",
      new_string: "replaced",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toBe("replaced\nline3");
  });

  test("preserves new_string as-is even when old_string needed unescaping", async () => {
    // File has actual newlines
    const original = "line1\nline2\nline3";
    await fs.writeFile(testFile, original);

    // old_string is over-escaped, new_string has intentional \\n (literal)
    const result = await edit({
      file_path: testFile,
      old_string: "line1\\nline2",
      new_string: "keep\\nliteral",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    // new_string should NOT be unescaped - literal backslash-n should remain
    expect(content).toBe("keep\\nliteral\nline3");
  });

  test("handles over-escaped backticks", async () => {
    const original = "const msg = `Hello World`;";
    await fs.writeFile(testFile, original);

    // LLM provides over-escaped backticks
    const result = await edit({
      file_path: testFile,
      old_string: "const msg = \\`Hello World\\`;",
      new_string: "const msg = `Hi World`;",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toBe("const msg = `Hi World`;");
  });

  test("normalizes CRLF in old_string to match LF in file", async () => {
    // File has Unix line endings
    const original = "line1\nline2\nline3";
    await fs.writeFile(testFile, original);

    // old_string has Windows line endings (CRLF)
    const result = await edit({
      file_path: testFile,
      old_string: "line1\r\nline2",
      new_string: "lineA\nlineB",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toBe("lineA\nlineB\nline3");
  });

  test("normalizes CRLF in file to match LF in old_string", async () => {
    // File has Windows line endings
    const original = "line1\r\nline2\r\nline3";
    await fs.writeFile(testFile, original);

    // old_string has Unix line endings
    const result = await edit({
      file_path: testFile,
      old_string: "line1\nline2",
      new_string: "lineA\nlineB",
    });

    expect(result.replacements).toBe(1);
    const content = await fs.readFile(testFile, "utf-8");
    // File is normalized to LF
    expect(content).toBe("lineA\nlineB\nline3");
  });

  test("replace_all works with fallback unescaping", async () => {
    const original = "item\nitem\nitem";
    await fs.writeFile(testFile, original);

    const result = await edit({
      file_path: testFile,
      old_string: "item",
      new_string: "thing",
      replace_all: true,
    });

    expect(result.replacements).toBe(3);
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toBe("thing\nthing\nthing");
  });

  test("throws error when string not found even after unescaping", async () => {
    await fs.writeFile(testFile, "Hello World");

    await expect(
      edit({
        file_path: testFile,
        old_string: "Nonexistent",
        new_string: "Replacement",
      }),
    ).rejects.toThrow("String to replace not found in file");
  });

  test("throws error when old_string equals new_string", async () => {
    await fs.writeFile(testFile, "Hello World");

    await expect(
      edit({
        file_path: testFile,
        old_string: "Hello",
        new_string: "Hello",
      }),
    ).rejects.toThrow("old_string and new_string are exactly the same");
  });

  test("throws error for nonexistent file", async () => {
    await expect(
      edit({
        file_path: path.join(tempDir, "nonexistent.txt"),
        old_string: "foo",
        new_string: "bar",
      }),
    ).rejects.toThrow("File does not exist");
  });
});
