import {
  findLatestStableReleaseAfter,
  type Release,
  releaseNotesForRange,
} from "./release-analysis.ts";

function release(tag: string, publishedAt: string): Release {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
    body: `Notes for ${tag}`,
    published_at: publishedAt,
  };
}

const STABLES = [
  release("rust-v0.1.0", "2026-08-01T00:00:00Z"),
  release("rust-v0.2.0", "2026-08-02T00:00:00Z"),
  release("rust-v0.3.0", "2026-08-03T00:00:00Z"),
];

describe("Codex stable release range", () => {
  test("selects the latest release after the durable cursor", () => {
    expect(findLatestStableReleaseAfter(STABLES, "rust-v0.1.0")?.tag_name).toBe(
      "rust-v0.3.0",
    );
  });

  test("includes release notes for the full cursor-to-latest range", () => {
    const notes = releaseNotesForRange(STABLES, "rust-v0.1.0", "rust-v0.3.0");
    expect(notes).toContain("## [rust-v0.2.0]");
    expect(notes).toContain("Notes for rust-v0.2.0");
    expect(notes).toContain("## [rust-v0.3.0]");
    expect(notes).not.toContain("Notes for rust-v0.1.0");
    expect(() =>
      releaseNotesForRange(STABLES, "rust-v0.3.0", "rust-v0.2.0"),
    ).toThrow("Previous release rust-v0.3.0 must precede rust-v0.2.0");
  });

  test("returns null when the durable cursor is current", () => {
    expect(findLatestStableReleaseAfter(STABLES, "rust-v0.3.0")).toBeNull();
  });

  test("fails instead of skipping an unavailable cursor", () => {
    expect(() => findLatestStableReleaseAfter(STABLES, "rust-v0.0.9")).toThrow(
      "Could not find terminal release rust-v0.0.9",
    );
  });
});
