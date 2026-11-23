import { releaseDiscardedPlaceholders } from "@/cli/helpers/paste-registry";

const DRAFT_PLACEHOLDER_PATTERN =
  /\[(?:Pasted text #\d+ \+\d+ lines|Image #\d+)\]/g;

export type DraftPlaceholderDiscards = {
  noteEdit: (previous: string, next: string) => void;
  release: (
    discarded: string,
    keepTexts: ReadonlyArray<string | null | undefined>,
  ) => void;
};

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
