import { describe, expect, test } from "bun:test";

import {
  parseModelLabel,
  sortHandlesByFamilyAndVersion,
  sortModelsByFamilyAndVersion,
} from "../../cli/components/ModelSelector";

describe("parseModelLabel", () => {
  test("extracts family, version, and modifier from common label shapes", () => {
    expect(parseModelLabel("GLM-5.1")).toEqual({
      family: "glm",
      version: [5, 1],
      modifier: "",
    });
    expect(parseModelLabel("GLM-5")).toEqual({
      family: "glm",
      version: [5],
      modifier: "",
    });
    expect(parseModelLabel("GLM-4.7")).toEqual({
      family: "glm",
      version: [4, 7],
      modifier: "",
    });
    expect(parseModelLabel("MiniMax 2.7")).toEqual({
      family: "minimax",
      version: [2, 7],
      modifier: "",
    });
    expect(parseModelLabel("Kimi K2.6")).toEqual({
      family: "kimi k",
      version: [2, 6],
      modifier: "",
    });
    expect(parseModelLabel("GPT-5.1 Codex")).toEqual({
      family: "gpt",
      version: [5, 1],
      modifier: "codex",
    });
    expect(parseModelLabel("GPT-5.1 Codex Max")).toEqual({
      family: "gpt",
      version: [5, 1],
      modifier: "codex max",
    });
    expect(parseModelLabel("GPT-5.5 (ChatGPT)")).toEqual({
      family: "gpt",
      version: [5, 5],
      modifier: "(chatgpt)",
    });
    expect(parseModelLabel("GPT-5.5 Fast (ChatGPT)")).toEqual({
      family: "gpt",
      version: [5, 5],
      modifier: "fast (chatgpt)",
    });
    expect(parseModelLabel("Opus 4.6")).toEqual({
      family: "opus",
      version: [4, 6],
      modifier: "",
    });
    expect(parseModelLabel("Opus 4.7")).toEqual({
      family: "opus",
      version: [4, 7],
      modifier: "",
    });
    expect(parseModelLabel("Bedrock Opus 4.6")).toEqual({
      family: "bedrock opus",
      version: [4, 6],
      modifier: "",
    });
  });

  test("keeps size modifiers like 1M as part of the family's modifier", () => {
    // "1M" is a context-window variant of Opus 4.6, not its own family —
    // should sort adjacent to Opus 4.6 via the modifier tiebreak.
    expect(parseModelLabel("Opus 4.6 1M")).toEqual({
      family: "opus",
      version: [4, 6],
      modifier: "1m",
    });
  });

  test("normalizes casing so MiniMax variants group together", () => {
    expect(parseModelLabel("MiniMax 2.7").family).toBe(
      parseModelLabel("Minimax 2.5").family,
    );
  });

  test("defaults to version [0] when no digits are present", () => {
    expect(parseModelLabel("Haiku")).toEqual({
      family: "haiku",
      version: [0],
      modifier: "",
    });
  });
});

describe("sortModelsByFamilyAndVersion", () => {
  test("puts newer versions first within a family", () => {
    const sorted = sortModelsByFamilyAndVersion([
      { label: "GLM-4.7" },
      { label: "GLM-5" },
      { label: "GLM-5.1" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual(["GLM-5.1", "GLM-5", "GLM-4.7"]);
  });

  test("preserves family order by first appearance, newer within family", () => {
    // Default behavior (no priorityFamilies) — families appear in the order
    // they first show up in the input, newest version first within each.
    const sorted = sortModelsByFamilyAndVersion([
      { label: "GLM-4.7" },
      { label: "GPT-5.1 Codex" },
      { label: "GPT-5.2 Codex" },
      { label: "GLM-5.1" },
      { label: "GLM-5" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual([
      "GLM-5.1",
      "GLM-5",
      "GLM-4.7",
      "GPT-5.2 Codex",
      "GPT-5.1 Codex",
    ]);
  });

  test("priorityFamilies pins listed families to the top in order", () => {
    // Even though GLM shows up first in the input, passing priorityFamilies
    // makes GPT lead. Non-priority families keep their first-appearance
    // order afterwards.
    const sorted = sortModelsByFamilyAndVersion(
      [
        { label: "GLM-4.7" },
        { label: "GPT-5.1 Codex" },
        { label: "GPT-5.2 Codex" },
        { label: "GLM-5.1" },
      ],
      { priorityFamilies: ["gpt"] },
    );
    expect(sorted.map((m) => m.label)).toEqual([
      "GPT-5.2 Codex",
      "GPT-5.1 Codex",
      "GLM-5.1",
      "GLM-4.7",
    ]);
  });

  test("featured wins the tiebreak only when versions are equal", () => {
    const sorted = sortModelsByFamilyAndVersion([
      { label: "Kimi K2.5", isFeatured: false },
      { label: "Kimi K2.5", isFeatured: true },
    ]);
    // Same version → featured entry should surface first.
    expect(sorted[0]?.isFeatured).toBe(true);
  });

  test("newer version beats featured on an older version", () => {
    // This guarantees we don't regress into "featured first, version second"
    // — the user explicitly asked for newer-first.
    const sorted = sortModelsByFamilyAndVersion([
      { label: "GPT-5.1", isFeatured: true },
      { label: "GPT-5.5", isFeatured: false },
    ]);
    expect(sorted.map((m) => m.label)).toEqual(["GPT-5.5", "GPT-5.1"]);
  });

  test("base model sorts before its 1M variant of the same version", () => {
    // Opus 4.6 and Opus 4.6 1M share family + version — modifier tiebreak
    // keeps them adjacent and puts the base ("") before "1m".
    const sorted = sortModelsByFamilyAndVersion([
      { label: "Opus 4.6 1M" },
      { label: "Opus 4.7" },
      { label: "Opus 4.6" },
      { label: "Opus 4.5" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual([
      "Opus 4.7",
      "Opus 4.6",
      "Opus 4.6 1M",
      "Opus 4.5",
    ]);
  });

  test("Anthropic tier models group by generation, smaller tier first", () => {
    // The user's exact requested ordering: generation first, then tier
    // (Haiku < Sonnet < Opus), then modifier (base before 1M).
    const sorted = sortModelsByFamilyAndVersion([
      { label: "Opus 4.5" },
      { label: "Opus 4.6 1M" },
      { label: "Opus 4.6" },
      { label: "Sonnet 4.6 1M" },
      { label: "Sonnet 4.6" },
      { label: "Opus 4.7" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual([
      "Opus 4.7",
      "Sonnet 4.6",
      "Sonnet 4.6 1M",
      "Opus 4.6",
      "Opus 4.6 1M",
      "Opus 4.5",
    ]);
  });

  test("Haiku leads within a generation when present", () => {
    // Tier order is Haiku → Sonnet → Opus at the same version.
    const sorted = sortModelsByFamilyAndVersion([
      { label: "Opus 4.5" },
      { label: "Sonnet 4.5" },
      { label: "Haiku 4.5" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual([
      "Haiku 4.5",
      "Sonnet 4.5",
      "Opus 4.5",
    ]);
  });

  test("Bedrock Opus stays separate from the Anthropic generation group", () => {
    // "Bedrock Opus" parses as its own family and isn't in the default
    // generation group, so it doesn't fold into the Anthropic block — but
    // it still follows first-appearance order across the sortFamily keys.
    const sorted = sortModelsByFamilyAndVersion([
      { label: "Sonnet 4.6" },
      { label: "Bedrock Opus 4.6" },
      { label: "Opus 4.6" },
    ]);
    // Sonnet (sortFamily=anthropic) shows first, then bedrock-opus after.
    expect(sorted.map((m) => m.label)).toEqual([
      "Sonnet 4.6",
      "Opus 4.6",
      "Bedrock Opus 4.6",
    ]);
  });

  test("custom generationGroups can override the default", () => {
    const sorted = sortModelsByFamilyAndVersion(
      [{ label: "GPT-5.5" }, { label: "GPT-5.4 Fast" }, { label: "Opus 4.7" }],
      { generationGroups: [] },
    );
    // No generation grouping — GPT family leads by first appearance.
    expect(sorted.map((m) => m.label)).toEqual([
      "GPT-5.5",
      "GPT-5.4 Fast",
      "Opus 4.7",
    ]);
  });

  test("base and Fast variants interleave by version within GPT family", () => {
    // Matches the user's explicit request:
    //   GPT 5.5, GPT 5.5 Fast, GPT 5.4, GPT 5.4 Fast, GPT 5.3 Codex, GPT 5.2
    const sorted = sortModelsByFamilyAndVersion([
      { label: "GPT-5.2" },
      { label: "GPT-5.3 Codex" },
      { label: "GPT-5.4" },
      { label: "GPT-5.4 Fast" },
      { label: "GPT-5.5" },
      { label: "GPT-5.5 Fast" },
    ]);
    expect(sorted.map((m) => m.label)).toEqual([
      "GPT-5.5",
      "GPT-5.5 Fast",
      "GPT-5.4",
      "GPT-5.4 Fast",
      "GPT-5.3 Codex",
      "GPT-5.2",
    ]);
  });
});

describe("sortHandlesByFamilyAndVersion", () => {
  test("sorts raw handles via looked-up labels", () => {
    const labels: Record<string, string> = {
      "zai/glm-4.7": "GLM-4.7",
      "zai/glm-5": "GLM-5",
      "zai/glm-5.1": "GLM-5.1",
    };
    const sorted = sortHandlesByFamilyAndVersion(
      ["zai/glm-4.7", "zai/glm-5", "zai/glm-5.1"],
      (h) => labels[h],
    );
    expect(sorted).toEqual(["zai/glm-5.1", "zai/glm-5", "zai/glm-4.7"]);
  });

  test("handles without a known label fall back to the handle string", () => {
    // Unknown handle uses itself as its label so the family key is just the
    // handle text. Family order follows first appearance in the input, so the
    // unknown handle leads its own one-item group and the GLM group sorts
    // newer-first inside itself.
    const sorted = sortHandlesByFamilyAndVersion(
      ["zai/glm-5", "zai/glm-5.1", "unknown/mystery-model"],
      (h) =>
        h.startsWith("zai/")
          ? h.replace("zai/", "GLM-").toUpperCase()
          : undefined,
    );
    expect(sorted).toEqual([
      "zai/glm-5.1",
      "zai/glm-5",
      "unknown/mystery-model",
    ]);
  });
});
