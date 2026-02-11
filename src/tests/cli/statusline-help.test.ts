import { describe, expect, test } from "bun:test";
import { formatStatusLineHelp } from "../../cli/helpers/statusLineHelp";

describe("statusLineHelp", () => {
  test("includes compatibility sections and unsupported field notes", () => {
    const output = formatStatusLineHelp(null);

    expect(output).toContain("/statusline help");
    expect(output).toContain("FIELD SUPPORT MATRIX");
    expect(output).toContain("native (fully supported now)");
    expect(output).toContain("derived (computed approximation)");
    expect(output).toContain("unsupported (currently not native in Letta");
    expect(output).toContain("vim.mode");
    expect(output).toContain("cost.total_cost_usd");
  });

  test("includes effective config details when provided", () => {
    const output = formatStatusLineHelp({
      type: "command",
      command: "echo hi",
      padding: 2,
      timeout: 5000,
      debounceMs: 300,
      refreshIntervalMs: 10000,
    });

    expect(output).toContain("Effective config:");
    expect(output).toContain("command: echo hi");
    expect(output).toContain("padding: 2");
    expect(output).toContain("refreshIntervalMs: 10000");
  });
});
