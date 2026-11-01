import { describe, expect, test } from "bun:test";
import { tryImportClipboardImage } from "./clipboard";

describe("tryImportClipboardImage", () => {
  test("returns null when the reader finds no image", async () => {
    expect(await tryImportClipboardImage(async () => null)).toBeNull();
  });

  test("reports a reader failure as a paste error", async () => {
    const result = await tryImportClipboardImage(async () => {
      throw new Error("wl-paste timed out");
    });

    expect(result).toEqual({ error: "Image paste failed: wl-paste timed out" });
  });

  test("reports a synchronous reader failure as a paste error", async () => {
    const result = await tryImportClipboardImage(() => {
      throw new Error("temp file vanished");
    });

    expect(result).toEqual({
      error: "Image paste failed: temp file vanished",
    });
  });

  test("allocates a placeholder for an image the reader returns", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const result = await tryImportClipboardImage(() => ({
      data: png,
      mediaType: "image/png",
    }));

    expect(result).toMatchObject({
      placeholder: expect.stringMatching(/^\[Image #\d+\]$/),
    });
  });
});
