import { expect, test } from "bun:test";
import {
  getAllSubagentConfigs,
  resolveSubagentConfigForMemoryFormat,
} from "@/agent/subagents";
import { parseFrontmatter } from "@/utils/frontmatter";
import initV1 from "./init.md";
import initV2 from "./init-v2.md";

test("both init presets omit a model override", () => {
  for (const source of [initV1, initV2]) {
    expect(parseFrontmatter(source).frontmatter.model).toBeUndefined();
  }
});

test.each(["memfs-v1", "memfs-v2"] as const)(
  "init inherits the parent model with %s",
  async (format) => {
    const configs = await getAllSubagentConfigs(import.meta.dir);
    const init = configs.init;
    if (!init) throw new Error("Missing built-in init config");
    const config = resolveSubagentConfigForMemoryFormat(init, format, false);
    expect(config.recommendedModel).toBe("inherit");
    expect(config.recommendedModelSource).toBeUndefined();
  },
);
