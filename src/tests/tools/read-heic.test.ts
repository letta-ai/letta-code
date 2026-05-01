import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import sharp from "sharp";
import { read } from "../../tools/impl/Read";
import { TestDirectory } from "../helpers/testFs";

describe("Read tool HEIC support", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("reads .heic files as images on macOS", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    testDir = new TestDirectory();
    const pngPath = testDir.createBinaryFile(
      "photo.png",
      await sharp({
        create: {
          width: 96,
          height: 72,
          channels: 3,
          background: { r: 35, g: 140, b: 225 },
        },
      })
        .png()
        .toBuffer(),
    );
    const heicPath = testDir.resolve("photo.heic");

    execFileSync(
      "/usr/bin/sips",
      ["-s", "format", "heic", pngPath, "--out", heicPath],
      { stdio: "ignore" },
    );

    const result = await read({ file_path: heicPath });

    expect(Array.isArray(result.content)).toBe(true);
    if (!Array.isArray(result.content)) {
      throw new Error("Expected image content");
    }

    expect(result.content[0]).toEqual({
      type: "text",
      text: "[Image: photo.heic]",
    });
    const imagePart = result.content[1];
    if (
      !imagePart ||
      imagePart.type !== "image" ||
      imagePart.source.type !== "base64"
    ) {
      throw new Error("Expected image content part");
    }
    expect(imagePart.source.media_type).toBe("image/jpeg");
  });

  test("reads .heif files as images on macOS", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    testDir = new TestDirectory();
    const pngPath = testDir.createBinaryFile(
      "photo.png",
      await sharp({
        create: {
          width: 96,
          height: 72,
          channels: 3,
          background: { r: 60, g: 120, b: 210 },
        },
      })
        .png()
        .toBuffer(),
    );
    const heicPath = testDir.resolve("photo.heic");
    const heifPath = testDir.resolve("photo.heif");

    execFileSync(
      "/usr/bin/sips",
      ["-s", "format", "heic", pngPath, "--out", heicPath],
      { stdio: "ignore" },
    );
    cpSync(heicPath, heifPath);

    const result = await read({ file_path: heifPath });

    expect(Array.isArray(result.content)).toBe(true);
    if (!Array.isArray(result.content)) {
      throw new Error("Expected image content");
    }

    expect(result.content[0]).toEqual({
      type: "text",
      text: "[Image: photo.heif]",
    });
    const imagePart = result.content[1];
    if (
      !imagePart ||
      imagePart.type !== "image" ||
      imagePart.source.type !== "base64"
    ) {
      throw new Error("Expected image content part");
    }
    expect(imagePart.source.media_type).toBe("image/jpeg");
  });

  test("surfaces a clean image-read error when HEIC preparation fails", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heic",
      Buffer.from([0x00, 0x0a, 0x0b, 0x0c]),
    );

    await expect(read({ file_path: file })).rejects.toThrow(
      /Failed to read image file:/,
    );
  });
});
