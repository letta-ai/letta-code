import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("permission mode cycle order", () => {
  test("Shift+Tab cycles from fullAccess through acceptEdits, standard, and plan", () => {
    const inputRichPath = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(inputRichPath, "utf-8");

    expect(source).toContain("const modes: PermissionMode[] = [");
    expect(source).toContain(
      '"fullAccess",\n        "acceptEdits",\n        "standard",\n        "plan",',
    );
  });
});
