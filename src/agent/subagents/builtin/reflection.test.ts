import { describe, expect, test } from "bun:test";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { loadPreloadedSkills } from "@/agent/preloaded-skills";
import { resolveSkillSourcesSelection } from "@/agent/skill-sources";
import {
  getAllSubagentConfigs,
  resolveSubagentConfigForMemoryFormat,
} from "@/agent/subagents";
import { buildSubagentArgs } from "@/agent/subagents/manager";
import creatingSkills from "@/skills/builtin/creating-skills/SKILL.md";
import maintainingCoreMemory from "@/skills/builtin/maintaining-core-memory/SKILL.md";
import maintainingDeferredMemory from "@/skills/builtin/maintaining-deferred-memory/SKILL.md";
import reflectionPrompt from "./reflection.md";

test.each([
  ["reflection", "memfs-v1", "Bash,Edit"],
  ["reflection", "memfs-v2", "Bash,Edit"],
  ["memory", "memfs-v1", "Bash,Read,Edit,Write"],
  ["memory", "memfs-v2", "Bash,Read,Edit,Write"],
] as const)(
  "%s %s launch loads its bundled memory skills without expanding tools",
  async (type, format, tools) => {
    const configs = await getAllSubagentConfigs(import.meta.dir);
    const builtin = configs[type];
    if (!builtin) throw new Error(`Missing built-in ${type} config`);
    const config = resolveSubagentConfigForMemoryFormat(builtin, format, false);
    for (const platform of ["linux", "win32"] as const) {
      const args = buildSubagentArgs(
        type,
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
      expect(sources).toEqual([]);
      const catalog = await buildClientSkillsPayload({
        skillSources: sources,
        attachedRepositories: [],
      });
      expect(catalog.availableSkills).toEqual([]);
      const loaded = await loadPreloadedSkills(
        (args[preloadIndex + 1] ?? "").split(","),
        { skillSources: sources, attachedRepositories: [] },
      );
      const creating = `<creating-skills>\n${creatingSkills}\n</creating-skills>`;
      expect(loaded).toBe(
        format === "memfs-v2"
          ? `<loaded_skills>\n${creating}\n\n<maintaining-core-memory>\n${maintainingCoreMemory}\n</maintaining-core-memory>\n\n<maintaining-deferred-memory>\n${maintainingDeferredMemory}\n</maintaining-deferred-memory>\n</loaded_skills>`
          : `<loaded_skills>\n${creating}\n</loaded_skills>`,
      );
      expect(args[args.indexOf("--tools") + 1]).toBe(tools);
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
