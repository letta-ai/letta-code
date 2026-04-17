import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCavemanCommandPrompt,
  CAVEMAN_MODE_RULES,
  isCavemanCommandInput,
  normalizeCavemanMode,
} from "../../cli/commands/caveman";
import { commands } from "../../cli/commands/registry";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("/caveman command", () => {
  test("matches slash-first caveman commands with trailing whitespace separators", () => {
    const tab = "\t";
    const newline = "\n";

    expect(isCavemanCommandInput("/caveman")).toBe(true);
    expect(isCavemanCommandInput("/caveman ultra")).toBe(true);
    expect(isCavemanCommandInput(`/caveman${tab}ultra`)).toBe(true);
    expect(isCavemanCommandInput(`${tab}/caveman${newline}ultra`)).toBe(false);
    expect(isCavemanCommandInput("/cavemanultra")).toBe(false);
    expect(isCavemanCommandInput("/caveman-mode ultra")).toBe(false);
  });

  test("normalizes supported cave-code modes", () => {
    expect(normalizeCavemanMode("")).toBe("full");
    expect(normalizeCavemanMode("lite")).toBe("lite");
    expect(normalizeCavemanMode("full")).toBe("full");
    expect(normalizeCavemanMode("ultra")).toBe("ultra");
    expect(normalizeCavemanMode("ulta")).toBe("ultra");
    expect(normalizeCavemanMode("wenyan")).toBe("wenyan-full");
    expect(normalizeCavemanMode("wenyan-lite")).toBe("wenyan-lite");
    expect(normalizeCavemanMode("wenyan-full")).toBe("wenyan-full");
    expect(normalizeCavemanMode("wenyan-ultra")).toBe("wenyan-ultra");
    expect(normalizeCavemanMode("wenyan-ulta")).toBe("wenyan-ultra");
    expect(normalizeCavemanMode("verbose")).toBeNull();
  });

  test("builds a mode-switch prompt that preserves reasoning messages", () => {
    const prompt = buildCavemanCommandPrompt("ultra");

    expect(prompt).toContain("Switch to cave-code ultra mode.");
    expect(prompt).toContain("abbreviate common technical nouns");
    expect(prompt).toContain("Inline obj prop → new ref → re-render");
    expect(prompt).toContain("Apply this mode for this conversation only");
    expect(prompt).toContain("Do not call any tools");
    expect(prompt).toContain("every reasoning_message must be non-empty");
    expect(prompt).toContain("never analyst prose");
  });

  test("includes concrete per-mode rules in each mode-switch prompt", () => {
    expect(buildCavemanCommandPrompt("lite")).toContain(
      "keep articles and complete professional sentences",
    );
    expect(buildCavemanCommandPrompt("full")).toContain(
      "classic cave-code compression",
    );
    expect(buildCavemanCommandPrompt("wenyan-lite")).toContain(
      "semi-classical Chinese register",
    );
    expect(buildCavemanCommandPrompt("wenyan-full")).toContain("文言文");
    expect(buildCavemanCommandPrompt("wenyan-ultra")).toContain(
      "maximum compression",
    );
  });

  test("keeps mode-switch examples aligned with the bundled skill", () => {
    const skillPath = fileURLToPath(
      new URL("../../skills/builtin/caveman/SKILL.md", import.meta.url),
    );
    const skillSource = readFileSync(skillPath, "utf-8");

    for (const [mode, rules] of Object.entries(CAVEMAN_MODE_RULES)) {
      const exampleRule = rules.find((rule) =>
        rule.startsWith("Example style: "),
      );
      expect(exampleRule).toBeDefined();
      if (!exampleRule) {
        throw new Error(`Missing example rule for ${mode}`);
      }
      const example = exampleRule.replace("Example style: ", "");
      const pattern = new RegExp(
        `-\\s+${escapeRegex(mode)}:\\s+"${escapeRegex(example)}"`,
      );
      expect(skillSource).toMatch(pattern);
    }
  });

  test("registers /caveman as a built-in slash command", () => {
    expect(commands["/caveman"]).toMatchObject({
      desc: "Switch cave-code mode",
    });
  });
});
