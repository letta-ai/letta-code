import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { validateCodeownersSource } from "./check-codeowners-paths.js";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "codeowners-check-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "owned.ts"), "export {};\n");
  writeFileSync(join(root, "src", "nested", "NOTICE"), "notice\n");
  return root;
}

describe("CODEOWNERS literal path validation", () => {
  test("accepts existing root-relative files and directories", () => {
    const root = createRepository();
    const result = validateCodeownersSource(
      ["/src/owned.ts @owner", "/src/nested/ @owner", "/docs/ @owner"].join(
        "\n",
      ),
      root,
    );

    assert.deepEqual(result, {
      checkedLiterals: 3,
      skippedPatterns: 0,
      errors: [],
    });
  });

  test("reports stale literal paths with their source line", () => {
    const root = createRepository();
    const result = validateCodeownersSource(
      ["# comment", "", "/src/renamed.ts @owner"].join("\n"),
      root,
    );

    assert.deepEqual(result.errors, [{ line: 3, pattern: "/src/renamed.ts" }]);
  });

  test("skips glob rules instead of requiring a literal match", () => {
    const root = createRepository();
    const result = validateCodeownersSource(
      ["/src/**/*.ts @owner", "/generated/file?.js @owner"].join("\n"),
      root,
    );

    assert.equal(result.checkedLiterals, 0);
    assert.equal(result.skippedPatterns, 2);
    assert.deepEqual(result.errors, []);
  });

  test("accepts an unanchored literal name found below the root", () => {
    const root = createRepository();
    const result = validateCodeownersSource("NOTICE @owner", root);

    assert.deepEqual(result.errors, []);
    assert.equal(result.checkedLiterals, 1);
  });

  test("requires exact path casing on case-insensitive filesystems", () => {
    const root = createRepository();
    const result = validateCodeownersSource("/src/Owned.ts @owner", root);

    assert.deepEqual(result.errors, [{ line: 1, pattern: "/src/Owned.ts" }]);
  });
});
