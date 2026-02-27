import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("permission mode cycle order", () => {
  test("Shift+Tab cycles from default to plan before edit and yolo modes", () => {
    const inputRichPath = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(inputRichPath, "utf-8");

    expect(source).toContain('const modes: PermissionMode[] = [');
    expect(source).toContain('"default",\n        "plan",\n        "acceptEdits",');
    expect(source).toContain('"acceptEdits",\n        "bypassPermissions",');
  });
});
