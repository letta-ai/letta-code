import { describe, expect, test } from "bun:test";

import {
  parseShellAnalysis,
  splitShellSegments,
} from "../permissions/shellAnalysis";

describe("shellAnalysis", () => {
  test("parses nested read-only control flow into structured nodes", () => {
    const nodes = parseShellAnalysis(
      'if [ -f apps/client-ui/package.json ]; then sed -n "1,20p" apps/client-ui/package.json; fi; for f in apps/workstation/ui/vite.config.ts apps/workstation/ui/vite.config.js; do if [ -f "$f" ]; then sed -n "1,20p" "$f"; fi; done',
    );

    expect(nodes).toEqual([
      {
        type: "if",
        condition: "[ -f apps/client-ui/package.json ]",
        thenBody: [
          {
            type: "command",
            segment: 'sed -n "1,20p" apps/client-ui/package.json',
          },
        ],
      },
      {
        type: "for",
        variableName: "f",
        items: [
          "apps/workstation/ui/vite.config.ts",
          "apps/workstation/ui/vite.config.js",
        ],
        body: [
          {
            type: "if",
            condition: '[ -f "$f" ]',
            thenBody: [
              {
                type: "command",
                segment: 'sed -n "1,20p" "$f"',
              },
            ],
          },
        ],
      },
    ]);
  });

  test("rejects unsupported else blocks", () => {
    expect(
      parseShellAnalysis(
        "if [ -f package.json ]; then sed -n '1,20p' package.json; else echo nope; fi",
      ),
    ).toBeNull();
  });

  test("keeps escaped find exec terminators inside a single segment", () => {
    expect(
      splitShellSegments(
        "find apps/workstation/dist/assets -maxdepth 1 -type f -name 'index-*.*' -exec stat -f '%Sm %N' -t '%Y-%m-%d %H:%M' {} \\; | sort | tail -n 20",
      ),
    ).toEqual([
      "find apps/workstation/dist/assets -maxdepth 1 -type f -name 'index-*.*' -exec stat -f '%Sm %N' -t '%Y-%m-%d %H:%M' {} \\;",
      "sort",
      "tail -n 20",
    ]);
  });

  test("rejects unsafe substitutions and redirects", () => {
    expect(parseShellAnalysis("echo $(rm file)")).toBeNull();
    expect(parseShellAnalysis("sed -n '1,20p' file > out.txt")).toBeNull();
  });
});
