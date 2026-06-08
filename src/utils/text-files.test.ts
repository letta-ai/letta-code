import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  decodeUtf8TextStrict,
  readUtf8TextStrict,
  writeUtf8Text,
} from "@/utils/text-files";

function utf16leWithBom(content: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(content, "utf16le"),
  ]);
}

describe("text file helpers", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("writes exact UTF-8 bytes without changing encoding", async () => {
    testDir = new TestDirectory();
    const file = testDir.resolve("unicode.txt");
    const content = "café 漢字 😀";

    await writeUtf8Text(file, content);

    expect(
      Buffer.compare(readFileSync(file), Buffer.from(content, "utf8")),
    ).toBe(0);
  });

  test("strict read preserves UTF-8 BOM behavior", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("bom.txt", "");
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello", "utf8"),
    ]);
    await Bun.write(file, content);

    expect(await readUtf8TextStrict(file)).toBe("\ufeffhello");
  });

  test("strict decode rejects UTF-16LE BOM with stable error", () => {
    const file = "/tmp/utf16.md";

    expect(() => decodeUtf8TextStrict(utf16leWithBom("hello"), file)).toThrow(
      `File is not valid UTF-8 text: ${file}. Detected UTF-16LE BOM; convert the file to UTF-8 and retry.`,
    );
  });

  test("strict decode rejects invalid UTF-8 bytes with stable error", () => {
    const file = "/tmp/invalid.txt";

    expect(() => decodeUtf8TextStrict(Buffer.from([0xc3, 0x28]), file)).toThrow(
      `File is not valid UTF-8 text: ${file}. The file contains bytes that cannot be decoded as UTF-8.`,
    );
  });
});
