import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("input autocomplete history guard", () => {
  test("history navigation fully yields to autocomplete while suggestions are active", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("if (isAutocompleteActive) {");
    expect(source).not.toContain(
      "if (isAutocompleteActive && historyIndex === -1)",
    );
  });

  test("activating autocomplete clears latent history-navigation state", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain(
      "const handleAutocompleteActiveChange = useCallback((isActive: boolean) => {",
    );
    expect(source).toContain('setHistoryIndex(-1);');
    expect(source).toContain('setTemporaryInput("");');
    expect(source).toContain(
      'onAutocompleteActiveChange={handleAutocompleteActiveChange}',
    );
  });
});