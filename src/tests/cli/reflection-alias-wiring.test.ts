import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "../helpers/readInteractiveAppSource";

describe("reflection alias wiring", () => {
  test("routes /reflection through the manual reflection launch path", () => {
    const source = readInteractiveAppSource();

    const start = source.indexOf(
      '// Special handling for /reflect and /reflection - manually launch reflection subagent',
    );
    const end = source.indexOf(
      '// Special handling for /plan command - enter plan mode',
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      'if (trimmed === "/reflect" || trimmed === "/reflection") {',
    );
    expect(segment).toContain('spawnBackgroundSubagentTask({');
    expect(segment).toContain('subagentType: "reflection"');
  });
});
