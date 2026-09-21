import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translatePasteForImages } from "@/cli/helpers/clipboard";
import {
  allocateImage,
  allocatePaste,
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
  extractImagePlaceholderIds,
  extractTextPlaceholderIds,
  getImage,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";
import { view_image } from "@/tools/impl/view-image";

test("allocatePaste creates a placeholder", () => {
  const id = allocatePaste("Hello World");
  expect(id).toBeGreaterThan(0);
});

test("resolvePlaceholders resolves text placeholders", () => {
  const content = "Some long text\n".repeat(10);
  const id = allocatePaste(content);
  const placeholder = `[Pasted text #${id} +10 lines]`;
  const resolved = resolvePlaceholders(placeholder);
  expect(resolved).toBe(content);
});

test("allocateImage creates an image placeholder", () => {
  const id = allocateImage({
    data: "base64data",
    mediaType: "image/png",
  });
  expect(id).toBeGreaterThan(0);
});

test("buildMessageContentFromDisplay handles text only", () => {
  const content = buildMessageContentFromDisplay("Hello World");
  expect(content).toEqual([{ type: "text", text: "Hello World" }]);
});

test("buildMessageContentFromDisplay handles text placeholders", () => {
  const longText = "Line 1\n".repeat(10);
  const id = allocatePaste(longText);
  const display = `Before [Pasted text #${id} +10 lines] After`;
  const content = buildMessageContentFromDisplay(display);
  expect(content).toEqual([{ type: "text", text: `Before ${longText} After` }]);
});

test("buildMessageContentFromDisplay handles image placeholders", () => {
  const id = allocateImage({
    data: "abc123",
    mediaType: "image/png",
  });
  const display = `Text before [Image #${id}] text after`;
  const content = buildMessageContentFromDisplay(display);
  expect(content).toHaveLength(3);
  expect(content[0]?.type).toBe("text");
  expect(content[0]).toEqual({
    type: "text",
    text: `Text before <system-reminder>Image available at ${JSON.stringify(getImage(id)?.localPath)}</system-reminder>\n`,
  });
  expect(content[1]).toEqual({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "abc123",
    },
  });
  expect(content[2]).toEqual({ type: "text", text: " text after" });
});

test("uses content-aware safe extensions without trusting filenames", () => {
  const jpgId = allocateImage({ data: "/9j/2Q==", mediaType: "image/jpg" });
  expect(getImage(jpgId)?.localPath.endsWith(".jpg")).toBe(true);

  const unknownId = allocateImage({
    data: "abc123",
    mediaType: "application/octet-stream",
    filename: "../untrusted/path/photo.webp",
  });
  expect(getImage(unknownId)?.localPath.endsWith(".webp")).toBe(true);
  expect(getImage(unknownId)?.localPath).not.toContain("untrusted");

  const unsafeId = allocateImage({
    data: "abc123",
    mediaType: "application/octet-stream",
    filename: "photo.exe",
  });
  expect(getImage(unsafeId)?.localPath.endsWith(".img")).toBe(true);

  const pngData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const mislabeledId = allocateImage({
    data: pngData,
    mediaType: "image/jpeg",
    filename: "wrong.jpg",
  });
  expect(getImage(mislabeledId)?.localPath.endsWith(".png")).toBe(true);
});

test("pasted image uses a private stable copy independent of its source", async () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "letta-image-source-"));
  const sourcePath = join(sourceDirectory, "original.png");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(data, "base64");
  writeFileSync(sourcePath, bytes);

  const placeholder = translatePasteForImages(sourcePath);
  const [id] = extractImagePlaceholderIds(placeholder);
  const image = getImage(id as number);
  expect(image).toBeDefined();
  expect(image?.localPath).not.toBe(sourcePath);
  expect(image?.localPath.endsWith(".png")).toBe(true);
  expect(readFileSync(image?.localPath as string)).toEqual(bytes);
  if (process.platform !== "win32") {
    expect(statSync(image?.localPath as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(image?.localPath as string, "..")).mode & 0o777).toBe(
      0o700,
    );
  }

  unlinkSync(sourcePath);
  const content = buildMessageContentFromDisplay(placeholder);
  expect(readFileSync(image?.localPath as string)).toEqual(bytes);
  const viewed = await view_image({ path: image?.localPath as string });
  const viewedImage = viewed.content[1];
  expect(typeof viewedImage !== "string" && viewedImage?.type).toBe("image");
  expect(content).toEqual([
    {
      type: "text",
      text: `<system-reminder>Image available at ${JSON.stringify(image?.localPath)}</system-reminder>\n`,
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: bytes.toString("base64"),
      },
    },
  ]);
});

test("buildMessageContentFromDisplay handles mixed content", () => {
  const textId = allocatePaste("Pasted content");
  const imageId = allocateImage({
    data: "imgdata",
    mediaType: "image/jpeg",
  });
  const display = `Start [Pasted text #${textId} +1 lines] middle [Image #${imageId}] end`;
  const content = buildMessageContentFromDisplay(display);
  expect(content).toHaveLength(3);
  expect(content[0]?.type).toBe("text");
  expect(content[0]?.type === "text" && content[0].text).toMatch(
    /^Start Pasted content middle <system-reminder>Image available at "\/.*\.jpg"<\/system-reminder>\n$/,
  );
  expect(content[1]?.type).toBe("image");
  expect(content[2]).toEqual({ type: "text", text: " end" });
});

test("clearPlaceholdersInText removes referenced placeholders", () => {
  const id1 = allocatePaste("Content 1");
  const id2 = allocateImage({ data: "img", mediaType: "image/png" });
  const display = `[Pasted text #${id1} +1 lines] and [Image #${id2}]`;

  // Verify they resolve before clearing
  expect(resolvePlaceholders(display)).toContain("Content 1");

  clearPlaceholdersInText(display);

  // After clearing, placeholders should not resolve
  expect(resolvePlaceholders(display)).toBe(display);
});

test("extractTextPlaceholderIds extracts IDs correctly", () => {
  const display =
    "[Pasted text #123 +5 lines] and [Pasted text #456 +10 lines]";
  const ids = extractTextPlaceholderIds(display);
  expect(ids).toEqual([123, 456]);
});

test("extractImagePlaceholderIds extracts IDs correctly", () => {
  const display = "[Image #42] and [Image #99]";
  const ids = extractImagePlaceholderIds(display);
  expect(ids).toEqual([42, 99]);
});
