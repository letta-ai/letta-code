import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("plan approval option order", () => {
  test("option 1 (default) calls onApprove, not onApproveAndAcceptEdits", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/StaticPlanApproval.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // When showAcceptEditsOption is true, option 1 (Enter) should call onApprove
    // (restore previous mode), not onApproveAndAcceptEdits.
    // The Enter key handler should check effectiveSelectedOption === 1 for acceptEdits,
    // not === 0.
    expect(source).toContain(
      "showAcceptEditsOption && effectiveSelectedOption === 1",
    );

    // Number key 1 should always call onApprove (restore previous mode)
    // Find the section where input === "1" calls onApprove
    const numberKeySection = source.match(
      /if \(input === "1"\)[\s\S]*?return;/,
    );
    expect(numberKeySection).not.toBeNull();
    expect(numberKeySection?.[0]).toContain("onApprove()");
    expect(numberKeySection?.[0]).not.toContain("onApproveAndAcceptEdits()");

    // Number key 2 should call onApproveAndAcceptEdits
    const numberKey2Section = source.match(
      /if \(showAcceptEditsOption && input === "2"\)[\s\S]*?return;/,
    );
    expect(numberKey2Section).not.toBeNull();
    expect(numberKey2Section?.[0]).toContain("onApproveAndAcceptEdits()");
  });

  test("option 1 label says 'Yes, proceed' not 'auto-accept edits'", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/StaticPlanApproval.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // When showAcceptEditsOption=true, option 1 should say "Yes, proceed"
    expect(source).toContain('"Yes, proceed"');
    // Should NOT say "Yes, and auto-accept edits" (the old default)
    expect(source).not.toContain('"Yes, and auto-accept edits"');
  });

  test("option 2 label clarifies acceptEdits scope", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/StaticPlanApproval.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // Option 2 should clarify that acceptEdits auto-approves file edits but
    // still requires approval for commands
    expect(source).toContain("auto-accept file edits (approve commands)");
  });

  test("acceptEdits mode label clarifies scope in InputRich", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // The acceptEdits mode label should clarify that commands still require approval
    expect(source).toContain('"accept edits (approve commands)"');
  });

  test("acceptEdits permission mode description clarifies scope", () => {
    const path = fileURLToPath(
      new URL("../../reminders/engine.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // The acceptEdits description should mention that shell commands still require approval
    expect(source).toContain(
      '"File edits auto-approved; shell commands still require approval."',
    );
  });
});
