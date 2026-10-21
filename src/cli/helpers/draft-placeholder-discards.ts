import { releaseDiscardedPlaceholders } from "@/cli/helpers/paste-registry";

// Both placeholder forms the paste registry resolves.
const DRAFT_PLACEHOLDER_PATTERN =
  /\[(?:Pasted text #\d+ \+\d+ lines|Image #\d+)\]/g;

export type DraftPlaceholderDiscards = {
  noteEdit: (previous: string, next: string) => void;
  release: (
    discarded: string,
    keepTexts: ReadonlyArray<string | null | undefined>,
  ) => void;
};

/**
 * Tracks placeholders that edits removed from the draft. An edit must not free
 * them: the text input's kill buffer (Ctrl+K / Ctrl+U, then Ctrl+Y) or a
 * retyped bracket can bring the same placeholder back, and it must still
 * resolve. `release` runs at a boundary (submit, clear, draft replacement) and
 * frees the discarded text's and the noted placeholders that no keep text
 * references.
 */
export function createDraftPlaceholderDiscards(): DraftPlaceholderDiscards {
  const removed = new Set<string>();
  return {
    noteEdit(previous, next) {
      for (const placeholder of previous.match(DRAFT_PLACEHOLDER_PATTERN) ??
        []) {
        if (!next.includes(placeholder)) removed.add(placeholder);
      }
    },
    release(discarded, keepTexts) {
      const pending = [...removed];
      removed.clear();
      releaseDiscardedPlaceholders(
        [discarded, ...pending].join("\n"),
        keepTexts,
      );
    },
  };
}
