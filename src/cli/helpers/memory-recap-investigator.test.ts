import { describe, expect, test } from "bun:test";

import { buildMemoryRecapInvestigatorPrompt } from "./memory-recap-investigator";

describe("memory recap investigator", () => {
  test("builds an analysis-only prompt around the reflect auto candidate payload", () => {
    const prompt = buildMemoryRecapInvestigatorPrompt({
      instruction: "Focus on tool-use failures.",
    });

    expect(prompt).toContain("$TRANSCRIPT_PATH");
    expect(prompt).toContain("heuristic/search scores");
    expect(prompt).toContain("analysis-only");
    expect(prompt).toContain("do not edit memory files");
    expect(prompt).toContain("Focus on tool-use failures.");
    expect(prompt).toContain("recommended user questions");
  });
});
