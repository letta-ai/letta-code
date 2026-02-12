import { describe, expect, test } from "bun:test";
import { formatStatusLineHelp } from "../../cli/helpers/statusLineHelp";

describe("statusLineHelp", () => {
  test("includes configuration and input sections", () => {
    const output = formatStatusLineHelp();

    expect(output).toContain("/statusline help");
    expect(output).toContain("CONFIGURATION");
    expect(output).toContain("INPUT (via JSON stdin)");
    expect(output).toContain("model.display_name");
    expect(output).toContain("context_window.used_percentage");
  });

  test("lists all fields without section separation", () => {
    const output = formatStatusLineHelp();

    // Native and derived fields both present in a single list
    expect(output).toContain("cwd");
    expect(output).toContain("session_id");
    expect(output).toContain("context_window.remaining_percentage");
    expect(output).toContain("exceeds_200k_tokens");

    // No native/derived subheadings
    expect(output).not.toContain("\nnative\n");
    expect(output).not.toContain("\nderived\n");
  });

  test("does not include effective config section", () => {
    const output = formatStatusLineHelp();

    expect(output).not.toContain("Effective config:");
  });
});
