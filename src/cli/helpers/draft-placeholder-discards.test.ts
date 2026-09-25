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

function allocateDraftImage(): { id: number; display: string } {
  const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
  return { id, display: `[Image #${id}]` };
}

/**
 * InputRich releases a dropped holder (the parked history draft, an unrestored
 * input) through `release` with its keep set: [next draft, parked draft,
 * restored input, in-flight submission, ...queued texts]. The dropped holder is
 * zeroed first, so a stale copy of it cannot keep its entries alive.
 */
describe("dropped draft holders", () => {
  test("history exit on type releases the parked draft against the live composer", () => {
    const parked = allocateDraftImage();

    createDraftPlaceholderDiscards().release(parked.display, [
      "git statusx",
      "",
      null,
      null,
    ]);

    expect(getImage(parked.id)).toBeUndefined();
  });

  test("bash submit releases the parked draft and the submitted text", () => {
    const discards = createDraftPlaceholderDiscards();
    const parked = allocateDraftImage();
    const submitted = allocateDraftImage();

    discards.release(parked.display, ["", "", null, null]);
    discards.release(submitted.display, ["", "", null, null]);

    expect(getImage(parked.id)).toBeUndefined();
    expect(getImage(submitted.id)).toBeUndefined();
  });

  test("normal submit of a history entry releases the parked draft, not the in-flight text", () => {
    const parked = allocateDraftImage();
    const submitted = allocateDraftImage();

    createDraftPlaceholderDiscards().release(parked.display, [
      submitted.display,
      "",
      null,
      submitted.display,
    ]);

    expect(getImage(parked.id)).toBeUndefined();
    expect(getImage(submitted.id)).toBeDefined();
  });

  test("slash-command select releases the parked draft and the replaced draft", () => {
    const discards = createDraftPlaceholderDiscards();
    const parked = allocateDraftImage();
    const replaced = allocateDraftImage();

    discards.release(parked.display, ["/model", "", null, null]);
    discards.release(`/mo ${replaced.display}`, ["/model", "", null, null]);

    expect(getImage(parked.id)).toBeUndefined();
    expect(getImage(replaced.id)).toBeUndefined();
  });

  test("Ctrl+C while browsing history releases the parked draft and the wiped entry", () => {
    const discards = createDraftPlaceholderDiscards();
    const parked = allocateDraftImage();
    const historyEntry = allocateDraftImage();

    discards.release(historyEntry.display, ["", "", null, null]);
    discards.release(parked.display, ["", "", null, null]);

    expect(getImage(parked.id)).toBeUndefined();
    expect(getImage(historyEntry.id)).toBeUndefined();
  });

  test("consume-without-restore releases the restored input against the live composer", () => {
    const restored = allocateDraftImage();

    createDraftPlaceholderDiscards().release(restored.display, [
      "already typing",
      "",
      null,
      null,
    ]);

    expect(getImage(restored.id)).toBeUndefined();
  });

  test("consume-without-restore keeps an image the composer or queue still references", () => {
    const shared = allocateDraftImage();
    const queued = allocateDraftImage();
    const dropped = allocateDraftImage();

    createDraftPlaceholderDiscards().release(
      `${shared.display} ${queued.display} ${dropped.display}`,
      [`keep ${shared.display}`, "", null, null, queued.display],
    );

    expect(getImage(shared.id)).toBeDefined();
    expect(getImage(queued.id)).toBeDefined();
    expect(getImage(dropped.id)).toBeUndefined();
  });

  test("a stale parked-draft copy keeps the entry until the holder is zeroed", () => {
    const discards = createDraftPlaceholderDiscards();
    const parked = allocateDraftImage();

    // The leak: the parked draft is dropped but still listed as a holder.
    discards.release(parked.display, ["git status", parked.display, null]);
    expect(getImage(parked.id)).toBeDefined();

    discards.release(parked.display, ["git status", "", null]);
    expect(getImage(parked.id)).toBeUndefined();
  });

  test("a holder drop also frees placeholders noted by earlier edits", () => {
    const discards = createDraftPlaceholderDiscards();
    const parked = allocateDraftImage();
    const deleted = allocateDraftImage();
    const yanked = allocateDraftImage();

    discards.noteEdit(`${deleted.display} ${yanked.display}`, "");
    // The yanked placeholder is back in the live draft when the holder drops.
    discards.release(parked.display, [`x ${yanked.display}`, "", null, null]);

    expect(getImage(parked.id)).toBeUndefined();
    expect(getImage(deleted.id)).toBeUndefined();
    expect(getImage(yanked.id)).toBeDefined();
  });
});
