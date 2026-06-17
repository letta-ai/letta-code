import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf-8",
  );
}

describe("reflection alias wiring", () => {
  test("routes /reflection through the manual reflection launch path", () => {
    const source = readSource("../../cli/app/use-submit-handler.ts");

    const start = source.indexOf(
      "// Special handling for /reflect and /reflection - manually launch reflection subagent",
    );
    const end = source.indexOf("// Special handling for /init command", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      'if (trimmed === "/reflect" || trimmed === "/reflection") {',
    );
    expect(segment).toContain("spawnBackgroundSubagentTask({");
    expect(segment).toContain('subagentType: "reflection"');
  });
});
