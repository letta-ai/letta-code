import { expect, test } from "bun:test";
import {
  allocateImage,
  allocatePaste,
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
  extractImagePlaceholderIds,
  extractTextPlaceholderIds,
  resolvePlaceholders,
} from "../cli/helpers/pasteRegistry";

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
  expect(content[0]).toEqual({ type: "text", text: "Text before " });
  expect(content[1]).toEqual({
    type: "image",
    source: {
      type: "base64",
      mediaType: "image/png",
      data: "abc123",
    },
  });
  expect(content[2]).toEqual({ type: "text", text: " text after" });
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
  expect(content[0]).toEqual({
    type: "text",
    text: "Start Pasted content middle ",
  });
  expect(content[1].type).toBe("image");
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
