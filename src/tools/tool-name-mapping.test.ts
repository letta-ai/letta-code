import { describe, expect, test } from "bun:test";
import { getInternalToolName, getServerToolName } from "./tool-name-mapping";

describe("tool name mapping", () => {
  test("maps internal names to server names and back", () => {
    expect(getServerToolName("Task")).toBe("Agent");
    expect(getInternalToolName("Agent")).toBe("Task");
    expect(getServerToolName("Bash")).toBe("Bash");
    expect(getInternalToolName("Bash")).toBe("Bash");
  });

  test("tool definitions load first in a fresh process without a TDZ cycle", () => {
    const script = `
      await import("./src/tools/tool-definitions.ts");
      const { TOOL_NAMES } = await import("./src/tools/manager.ts");
      console.log(TOOL_NAMES.length > 0 ? "ok" : "empty");
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: `${import.meta.dir}/../..`,
    });

    expect(result.stderr.toString()).not.toContain("before initialization");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("ok");
  });
});
