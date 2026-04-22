import { describe, expect, test } from "bun:test";
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
});
