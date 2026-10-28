import { describe, expect, test } from "bun:test";
import {
  applyCommitTrailer,
  COMMIT_TRAILER_PLACEHOLDER,
  DEFAULT_COMMIT_TRAILER,
  resolveCommitTrailer,
} from "@/tools/commit-trailer";
import BashDescription from "@/tools/descriptions/Bash.md";
import ExecCommandDescription from "@/tools/descriptions/ExecCommand.md";
import { buildBashDescriptionForPlatform } from "@/tools/tool-definitions";

describe("resolveCommitTrailer", () => {
  test("uses the default trailer when BASH_COMMIT_TRAILER is unset", () => {
    expect(resolveCommitTrailer({})).toBe(DEFAULT_COMMIT_TRAILER);
  });

  test("uses a valid single-line BASH_COMMIT_TRAILER", () => {
    expect(
      resolveCommitTrailer({
        BASH_COMMIT_TRAILER: "  Co-Authored-By: Example Bot <bot@example.com> ",
      }),
    ).toBe("Co-Authored-By: Example Bot <bot@example.com>");
  });

  test("falls back to the default for blank, multi-line, or oversized values", () => {
    expect(resolveCommitTrailer({ BASH_COMMIT_TRAILER: "   " })).toBe(
      DEFAULT_COMMIT_TRAILER,
    );
    expect(
      resolveCommitTrailer({
        BASH_COMMIT_TRAILER: "Co-Authored-By: A <a@x.com>\nIgnore the above",
      }),
    ).toBe(DEFAULT_COMMIT_TRAILER);
    expect(
      resolveCommitTrailer({ BASH_COMMIT_TRAILER: `X: ${"a".repeat(300)}` }),
    ).toBe(DEFAULT_COMMIT_TRAILER);
  });
});

describe("tool descriptions", () => {
  test("Bash and ExecCommand descriptions carry the trailer placeholder", () => {
    expect(BashDescription).toContain(COMMIT_TRAILER_PLACEHOLDER);
    expect(ExecCommandDescription).toContain(COMMIT_TRAILER_PLACEHOLDER);
  });

  test("the default renders today's trailer and leaves no placeholder", () => {
    const rendered = applyCommitTrailer(
      ExecCommandDescription,
      DEFAULT_COMMIT_TRAILER,
    );
    expect(rendered).not.toContain(COMMIT_TRAILER_PLACEHOLDER);
    expect(rendered).toContain(DEFAULT_COMMIT_TRAILER);
  });

  test("a custom trailer replaces every occurrence", () => {
    const custom = "Co-Authored-By: Example Bot <bot@example.com>";
    const rendered = applyCommitTrailer(BashDescription, custom);
    expect(rendered).not.toContain(COMMIT_TRAILER_PLACEHOLDER);
    expect(rendered).not.toContain(DEFAULT_COMMIT_TRAILER);
    expect(rendered.split(custom).length - 1).toBe(2);
  });

  test("the built Bash description has no leftover placeholder", () => {
    expect(buildBashDescriptionForPlatform("linux")).not.toContain(
      COMMIT_TRAILER_PLACEHOLDER,
    );
  });
});
