import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import sharp from "sharp";
import { SYSTEM_REMINDER_OPEN } from "@/constants";
import { TestDirectory } from "@/test-utils/test-fs";
import { read } from "@/tools/impl/read";
import { MAX_IMAGE_HEIGHT, MAX_IMAGE_WIDTH } from "@/utils/image-resize";

describe("Read tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("reads a basic text file", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "test.txt",
      "Hello, World!\nLine 2\nLine 3",
    );

    const result = await read({ file_path: file });

    expect(result.content).toContain("Hello, World!");
    expect(result.content).toContain("Line 2");
    expect(result.content).toContain("Line 3");
  });

  test("reads UTF-8 file with Unicode characters", async () => {
    testDir = new TestDirectory();
    const content = "Hello 世界 🌍\n╔═══╗\n║ A ║\n╚═══╝";
    const file = testDir.createFile("unicode.txt", content);

    const result = await read({ file_path: file });

    expect(result.content).toContain("世界");
    expect(result.content).toContain("🌍");
    expect(result.content).toContain("╔═══╗");
  });

  test("formats output with line numbers", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("numbered.txt", "Line 1\nLine 2\nLine 3");

    const result = await read({ file_path: file });

    expect(result.content).toContain("1→Line 1");
    expect(result.content).toContain("2→Line 2");
    expect(result.content).toContain("3→Line 3");
  });

  test("respects offset parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "offset.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    const result = await read({ file_path: file, offset: 2 });

    expect(result.content).not.toContain("Line 1");
    expect(result.content).not.toContain("Line 2");
    expect(result.content).toContain("Line 3");
  });

  test("respects limit parameter", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile(
      "limit.txt",
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    );

    const result = await read({ file_path: file, limit: 2 });

    expect(result.content).toContain("Line 1");
    expect(result.content).toContain("Line 2");
    expect(result.content).not.toContain("Line 3");
  });

  test("clamps total output characters and points at overflow file", async () => {
    testDir = new TestDirectory();
    // 1,500 lines x ~120 chars ≈ 180K chars: under the 2,000-line and
    // 2,000-chars-per-line caps, but far over the 30K total-character clamp.
    // This is the exact shape of the bug where one Read returned 100K+ chars.
    const line = "x".repeat(119);
    const content = Array.from({ length: 1_500 }, () => line).join("\n");
    const file = testDir.createFile("wide.txt", content);

    const result = await read({ file_path: file, offset: 1, limit: 2000 });

    expect(typeof result.content).toBe("string");
    const text = result.content as string;
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain("[Output truncated: showing");
    expect(text).toContain(
      "[Use offset and limit parameters to read the file in smaller sections.]",
    );
    expect(text).toContain("[Full file content written to:");

    // Overflow file holds the full raw content; clean it up.
    const match = text.match(/Full file content written to: (.+\.txt)/);
    expect(match).toBeDefined();
    if (match?.[1]) {
      expect(fs.existsSync(match[1])).toBe(true);
      expect(fs.readFileSync(match[1], "utf-8")).toBe(content);
      fs.unlinkSync(match[1]);
    }
  });

  test("does not clamp reads under the total-character limit", async () => {
    testDir = new TestDirectory();
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const file = testDir.createFile("small.txt", content);

    const result = await read({ file_path: file });

    expect(result.content).not.toContain("[Output truncated");
    expect(result.content).not.toContain("[Full file content written to:");
  });

  test("detects binary files and throws error", async () => {
    testDir = new TestDirectory();
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    const file = testDir.createBinaryFile("binary.bin", binaryBuffer);

    await expect(read({ file_path: file })).rejects.toThrow(
      /Cannot read binary file/,
    );
  });

  test("reads TypeScript file with box-drawing characters", async () => {
    testDir = new TestDirectory();
    const tsContent = `// TypeScript file
const box = \`
┌─────────┐
│ Header  │
└─────────┘
\`;
export default box;
`;
    const file = testDir.createFile("ascii-art.ts", tsContent);

    const result = await read({ file_path: file });

    expect(result.content).toContain("┌─────────┐");
    expect(result.content).toContain("│ Header  │");
    expect(result.content).toContain("TypeScript file");
  });

  test("throws error when file_path is missing", async () => {
    await expect(read({} as Parameters<typeof read>[0])).rejects.toThrow(
      /missing required parameter.*file_path/,
    );
  });

  test("returns system reminder for empty files", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("empty.txt", "");

    const result = await read({ file_path: file });

    expect(result.content).toContain(SYSTEM_REMINDER_OPEN);
    expect(result.content).toContain("empty contents");
  });

  test("returns system reminder for whitespace-only files", async () => {
    testDir = new TestDirectory();
    const file = testDir.createFile("whitespace.txt", "   \n\n  \t  ");

    const result = await read({ file_path: file });

    expect(result.content).toContain(SYSTEM_REMINDER_OPEN);
    expect(result.content).toContain("empty contents");
  });

  test("reads images when LETTA_BASE_URL points to a local proxy", async () => {
    testDir = new TestDirectory();
    const originalBaseUrl = process.env.LETTA_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:58064";

    try {
      const pngBuffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5XQAAAAASUVORK5CYII=",
        "base64",
      );
      const imagePath = testDir.createBinaryFile("pixel.png", pngBuffer);

      const result = await read({ file_path: imagePath });

      expect(Array.isArray(result.content)).toBe(true);
      if (!Array.isArray(result.content)) {
        throw new Error("Expected image read to return multimodal content");
      }

      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content[1]).toMatchObject({ type: "image" });
      const imagePart = result.content[1];
      if (!imagePart || imagePart.type !== "image") {
        throw new Error("Expected second content part to be an image");
      }
      if (imagePart.source.type !== "base64") {
        throw new Error("Expected image content source to be base64");
      }
      expect(imagePart.source.media_type).toBe("image/png");
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
    }
  });

  test("clamps oversized image reads to Anthropic many-image limits", async () => {
    testDir = new TestDirectory();
    const originalBaseUrl = process.env.LETTA_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:58064";

    try {
      const oversizedBuffer = await sharp({
        create: {
          width: 3600,
          height: 2400,
          channels: 3,
          background: { r: 40, g: 130, b: 220 },
        },
      })
        .png()
        .toBuffer();
      const imagePath = testDir.createBinaryFile("large.png", oversizedBuffer);

      const result = await read({ file_path: imagePath });

      expect(Array.isArray(result.content)).toBe(true);
      if (!Array.isArray(result.content)) {
        throw new Error("Expected image read to return multimodal content");
      }

      const imagePart = result.content[1];
      if (!imagePart || imagePart.type !== "image") {
        throw new Error("Expected second content part to be an image");
      }
      if (imagePart.source.type !== "base64") {
        throw new Error("Expected image content source to be base64");
      }

      const resizedBuffer = Buffer.from(imagePart.source.data, "base64");
      const metadata = await sharp(resizedBuffer).metadata();

      expect(metadata.width).toBeDefined();
      expect(metadata.height).toBeDefined();
      expect(metadata.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
      expect(metadata.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
    }
  });
});
