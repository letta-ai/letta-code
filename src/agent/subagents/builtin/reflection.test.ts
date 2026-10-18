import { describe, expect, test } from "bun:test";
import { loadPreloadedSkills } from "@/agent/preloaded-skills";
import { resolveSkillSourcesSelection } from "@/agent/skill-sources";
import {
  getAllSubagentConfigs,
  resolveSubagentConfigForMemoryFormat,
} from "@/agent/subagents";
import { buildSubagentArgs } from "@/agent/subagents/manager";
import creatingSkills from "@/skills/builtin/creating-skills/SKILL.md";
import reflectionPrompt from "./reflection.md";

test.each(["memfs-v1", "memfs-v2"] as const)(
  "%s reflection launch can load its bundled authoring skill without expanding tools",
  async (format) => {
    const configs = await getAllSubagentConfigs(import.meta.dir);
    const reflection = configs.reflection;
    if (!reflection) throw new Error("Missing built-in reflection config");
    const config = resolveSubagentConfigForMemoryFormat(
      reflection,
      format,
      false,
    );
    for (const platform of ["linux", "win32"] as const) {
      const args = buildSubagentArgs(
        "reflection",
        config,
        null,
        "Review the transcript",
        undefined,
        undefined,
        undefined,
        { platform },
      );
      const preloadIndex = args.indexOf("--pre-load-skills");
      expect(preloadIndex).toBeGreaterThanOrEqual(0);
      const sources = resolveSkillSourcesSelection({
        noSkills: args.includes("--no-skills"),
        skillSourcesRaw: args[args.indexOf("--skill-sources") + 1],
      });
      expect(sources).toEqual(["bundled"]);
      const loaded = await loadPreloadedSkills(
        (args[preloadIndex + 1] ?? "").split(","),
        { skillSources: sources, attachedRepositories: [] },
      );
      expect(loaded).toContain(creatingSkills);
      expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Edit");
    }
  },
);

describe("reflection prompt shell guidance", () => {
  test("gives native Windows alternatives for terminal operations", () => {
    expect(reflectionPrompt).toContain(
      "the tool runs native PowerShell or cmd.exe on Windows",
    );
    expect(reflectionPrompt).toContain(
      "(Get-Item -LiteralPath $env:TRANSCRIPT_PATH).Length",
    );
    expect(reflectionPrompt).toContain("Join-Path $env:MEMORY_DIR");
    expect(reflectionPrompt).toContain("Get-Content");
    expect(reflectionPrompt).toContain("single-quoted here-string");
    expect(reflectionPrompt).toContain(
      "Set-Content -LiteralPath <path> -Encoding utf8",
    );
    expect(reflectionPrompt).toContain("check `$LASTEXITCODE` explicitly");
  });
});
