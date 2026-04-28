import { describe, expect, test } from "bun:test";
import { extractPrimaryShellCommand } from "../permissions/shell-command-normalization";
import {
  parseShellAnalysis,
  splitShellSegments,
  splitShellSegmentsAllowCommandSubstitution,
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

  test("command-substitution-aware splitter preserves outer separators", () => {
    const command =
      'export EXAMPLE_API_KEY=$(grep -E "^EXAMPLE_API_KEY=" .env | cut -d= -f2) && curl -s -u "$EXAMPLE_API_KEY:" "https://api.stripe.com/v1/customers/cus_examplecustomer0001" | jq -r "{id, email, name, description}"';

    expect(splitShellSegmentsAllowCommandSubstitution(command)).toEqual([
      'export EXAMPLE_API_KEY=$(grep -E "^EXAMPLE_API_KEY=" .env | cut -d= -f2)',
      'curl -s -u "$EXAMPLE_API_KEY:" "https://api.stripe.com/v1/customers/cus_examplecustomer0001"',
      'jq -r "{id, email, name, description}"',
    ]);
  });

  test("command-substitution-aware splitter still rejects unsafe redirects", () => {
    expect(
      splitShellSegmentsAllowCommandSubstitution(
        'export EXAMPLE_API_KEY=$(grep -E "^EXAMPLE_API_KEY=" .env | cut -d= -f2) && curl -s -u "$EXAMPLE_API_KEY:" "https://api.stripe.com/v1/customers/cus_examplecustomer0001" > out.json',
      ),
    ).toBeNull();
  });

  test("extractPrimaryShellCommand skips export setup segments", () => {
    const command =
      'export EXAMPLE_API_KEY=$(grep -E "^EXAMPLE_API_KEY=" .env | cut -d= -f2) && curl -s -u "$EXAMPLE_API_KEY:" "https://api.stripe.com/v1/customers/cus_examplecustomer0001" | jq -r "{id, email, name, description}"';

    expect(extractPrimaryShellCommand(command)).toBe(
      'curl -s -u "$EXAMPLE_API_KEY:" "https://api.stripe.com/v1/customers/cus_examplecustomer0001"',
    );
  });
});
