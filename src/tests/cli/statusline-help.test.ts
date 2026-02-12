import { describe, expect, test } from "bun:test";
import { formatStatusLineHelp } from "../../cli/helpers/statusLineHelp";

describe("statusLineHelp", () => {
  test("includes configuration and input field sections", () => {
    const output = formatStatusLineHelp(null);

    expect(output).toContain("/statusline help");
    expect(output).toContain("CONFIGURATION");
    expect(output).toContain("INPUT FIELDS (via JSON stdin)");
    expect(output).toContain("native");
    expect(output).toContain("derived");
    expect(output).toContain("model.display_name");
    expect(output).toContain("context_window.used_percentage");
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

  test("sanitizes home directory paths in config summary", () => {
    const output = formatStatusLineHelp({
      type: "command",
      command: "/Users/someuser/.letta/statusline.sh",
      padding: 0,
      timeout: 5000,
      debounceMs: 300,
      refreshIntervalMs: undefined,
    });

    expect(output).not.toContain("/Users/someuser/");
    expect(output).toContain("~/.letta/statusline.sh");
  });
});
