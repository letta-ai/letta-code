import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ImageContent, TextContent } from "@letta-ai/letta-client/resources/agents/messages";
import { TestDirectory } from "../helpers/testFs";

const resizeImageIfNeededMock = mock(async () => ({
  data: "resized-heic-base64",
  mediaType: "image/jpeg",
  width: 640,
  height: 480,
  resized: false,
}));

mock.module("../../cli/helpers/imageResize.js", () => ({
  resizeImageIfNeeded: resizeImageIfNeededMock,
}));

const { read } = await import("../../tools/impl/Read");

describe("Read tool HEIC support", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
    resizeImageIfNeededMock.mockReset();
    resizeImageIfNeededMock.mockResolvedValue({
      data: "resized-heic-base64",
      mediaType: "image/jpeg",
      width: 640,
      height: 480,
      resized: false,
    });
  });

  afterAll(() => {
    mock.restore();
  });

  test("routes .heic files through shared image resizing", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heic",
      Buffer.from([0x01, 0x02, 0x03, 0x04]),
    );

    const result = await read({ file_path: file });

    expect(resizeImageIfNeededMock).toHaveBeenCalledTimes(1);
    expect(resizeImageIfNeededMock.mock.calls[0]?.[1]).toBe("image/heic");
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<TextContent | ImageContent>;
    expect(content[0]).toEqual({ type: "text", text: "[Image: photo.heic]" });
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "resized-heic-base64",
      },
    });
  });

  test("routes .heif files through shared image resizing", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heif",
      Buffer.from([0x05, 0x06, 0x07, 0x08]),
    );

    await read({ file_path: file });

    expect(resizeImageIfNeededMock).toHaveBeenCalledTimes(1);
    expect(resizeImageIfNeededMock.mock.calls[0]?.[1]).toBe("image/heif");
  });

  test("surfaces a clean image-read error when HEIC preparation fails", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heic",
      Buffer.from([0x00, 0x0a, 0x0b, 0x0c]),
    );
    resizeImageIfNeededMock.mockImplementationOnce(async () => {
      throw new Error("codec unavailable");
    });

    await expect(read({ file_path: file })).rejects.toThrow(
      /Failed to read image file: .*codec unavailable/,
    );
  });
});
