/**
 * Tests for syncing-memory-filesystem script helpers
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseMdxFrontmatter } from "../../agent/memory";
import {
  hashFileBody,
  parseFrontmatter,
} from "../../skills/builtin/syncing-memory-filesystem/scripts/lib/frontmatter";

describe("syncing-memory-filesystem script frontmatter helpers", () => {
  test("parseFrontmatter matches parseMdxFrontmatter and trims body", () => {
    const content = [
      "---",
      "description: Test description",
      "limit: 123",
      "---",
      "",
      "Hello world",
      "",
    ].join("\n");

    const parsed = parseFrontmatter(content);
    const expected = parseMdxFrontmatter(content);

    expect(parsed).toEqual(expected);
    expect(parsed.body).toBe("Hello world");
  });

  test("hashFileBody uses trimmed body (no leading newline)", () => {
    const content = [
      "---",
      "description: Test description",
      "---",
      "",
      "Line one",
      "Line two",
    ].join("\n");

    const { body } = parseMdxFrontmatter(content);
    const expectedHash = createHash("sha256").update(body).digest("hex");

    expect(hashFileBody(content)).toBe(expectedHash);
  });
});
