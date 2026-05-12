import { afterEach, describe, expect, test } from "bun:test";
import { view_image } from "../../tools/impl/ViewImage";
import { TestDirectory } from "../helpers/testFs";

describe("ViewImage tool", () => {
  let testDir: TestDirectory;

  afterEach(() => {
    testDir?.cleanup();
  });

  test("accepts .heic paths and delegates to image reading", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heic",
      Buffer.from([0x00, 0x0a, 0x0b, 0x0c]),
    );

    await expect(view_image({ path: file })).rejects.toThrow(
      /Failed to read image file:/,
    );
  });

  test("accepts .heif paths and delegates to image reading", async () => {
    testDir = new TestDirectory();
    const file = testDir.createBinaryFile(
      "photo.heif",
      Buffer.from([0x00, 0x0d, 0x0e, 0x0f]),
    );

    await expect(view_image({ path: file })).rejects.toThrow(
      /Failed to read image file:/,
    );
  });
});
