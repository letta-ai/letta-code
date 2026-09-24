import { describe, expect, test } from "bun:test";
import { createDraftPlaceholderDiscards } from "@/cli/helpers/draft-placeholder-discards";
import {
  allocateImage,
  allocatePaste,
  getImage,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";

describe("createDraftPlaceholderDiscards", () => {
  test("an edit only notes removed placeholders; release frees unkept ones", () => {
    const discards = createDraftPlaceholderDiscards();
    const imageId = allocateImage({ data: "AAAA", mediaType: "image/png" });
    const draft = `look [Image #${imageId}] tail`;

    discards.noteEdit(draft, " tail");
    // Still registered: a kill-buffer yank could bring it back.
    expect(getImage(imageId)).toBeDefined();

    discards.release("", [" tail"]);
    expect(getImage(imageId)).toBeUndefined();
  });

  test("a noted placeholder that is back in a keep text survives release", () => {
    const discards = createDraftPlaceholderDiscards();
    const pasteId = allocatePaste("line 1\nline 2");
    const placeholder = `[Pasted text #${pasteId} +2 lines]`;

    discards.noteEdit(`a ${placeholder}`, "a ");
    discards.noteEdit("a ", `a ${placeholder}`);
    discards.release("", [`a ${placeholder}`]);

    expect(resolvePlaceholders(placeholder)).toBe("line 1\nline 2");
  });
});
