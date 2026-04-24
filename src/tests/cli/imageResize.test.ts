import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  resizeImageIfNeeded,
} from "../../cli/helpers/imageResize";

describe("resizeImageIfNeeded", () => {
  test("returns verified output dimensions for oversized images", async () => {
    const oversized = await sharp({
      create: {
        width: 3400,
        height: 2200,
        channels: 3,
        background: { r: 180, g: 70, b: 40 },
      },
    })
      .png()
      .toBuffer();

    const result = await resizeImageIfNeeded(oversized, "image/png");
    const resizedBuffer = Buffer.from(result.data, "base64");
    const metadata = await sharp(resizedBuffer).metadata();

    expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    expect(metadata.width).toBe(result.width);
    expect(metadata.height).toBe(result.height);
  });

  test("canonicalizes passthrough media types from decoded image bytes", async () => {
    const pngBuffer = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 90, g: 40, b: 180 },
      },
    })
      .png()
      .toBuffer();

    const result = await resizeImageIfNeeded(pngBuffer, "image/tiff");

    expect(result.mediaType).toBe("image/png");
  });

  test("converts HEIC inputs on macOS before applying model limits", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "letta-heic-resize-"));
    try {
      const pngBuffer = await sharp({
        create: {
          width: 128,
          height: 96,
          channels: 3,
          background: { r: 30, g: 140, b: 220 },
        },
      })
        .png()
        .toBuffer();
      const pngPath = join(tempRoot, "source.png");
      const heicPath = join(tempRoot, "source.heic");
      writeFileSync(pngPath, pngBuffer);

      execFileSync(
        "/usr/bin/sips",
        ["-s", "format", "heic", pngPath, "--out", heicPath],
        { stdio: "ignore" },
      );

      const heicBuffer = readFileSync(heicPath);
      const result = await resizeImageIfNeeded(heicBuffer, "image/heic");
      const resizedBuffer = Buffer.from(result.data, "base64");
      const metadata = await sharp(resizedBuffer).metadata();

      expect(result.mediaType).toBe("image/jpeg");
      expect(metadata.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
      expect(metadata.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
