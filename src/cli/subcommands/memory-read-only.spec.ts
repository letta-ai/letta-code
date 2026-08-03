import { describe, expect, it } from "bun:\u0074est";
import { checkPermission } from "@/permissions/checker";
import type { PermissionRules } from "@/permissions/types";
import { updateReadOnlyFrontmatter } from "./memory-read-only";

const permissions: PermissionRules = {
  allow: [],
  deny: [],
  ask: [],
  alwaysAsk: [],
  additionalDirectories: [],
};

describe("memory read-only", () => {
  it("adds and toggles read_only without changing the body", () => {
    const original = "---\ndescription: Keep\n---\n\nBody\n";
    const enabled = updateReadOnlyFrontmatter(original, true);
    expect(enabled).toBe(
      "---\ndescription: Keep\nread_only: true\n---\n\nBody\n",
    );
    expect(updateReadOnlyFrontmatter(enabled ?? "", false)).toContain(
      "read_only: false\n---\n\nBody\n",
    );
    expect(
      updateReadOnlyFrontmatter("---\r\ndescription: CRLF\r\n---\r\n", true),
    ).toContain("read_only: true\r\n---");
  });

  it("always requires approval", () => {
    for (const command of [
      "letta memory read-only system/persona.md true",
      `sh -c "letta memfs read-only reference/policy.md false"`,
    ]) {
      expect(checkPermission("Bash", { command }, permissions).decision).toBe(
        "alwaysAsk",
      );
    }
  });
});
