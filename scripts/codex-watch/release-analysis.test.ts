import {
  areAdjacentStableReleases,
  findNextStableRelease,
  type Release,
} from "./release-analysis.ts";

function release(tag: string, publishedAt: string): Release {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
    body: null,
    published_at: publishedAt,
  };
}

const STABLES = [
  release("rust-v0.1.0", "2026-08-01T00:00:00Z"),
  release("rust-v0.2.0", "2026-08-02T00:00:00Z"),
  release("rust-v0.3.0", "2026-08-03T00:00:00Z"),
];

describe("Codex stable release backlog", () => {
  test("selects the first release after the durable cursor", () => {
    expect(findNextStableRelease(STABLES, "rust-v0.1.0")?.tag_name).toBe(
      "rust-v0.2.0",
    );
  });

  test("identifies only adjacent stable release pairs", () => {
    expect(
      areAdjacentStableReleases(STABLES, "rust-v0.1.0", "rust-v0.2.0"),
    ).toBe(true);
    expect(
      areAdjacentStableReleases(STABLES, "rust-v0.1.0", "rust-v0.3.0"),
    ).toBe(false);
  });

  test("returns null when the durable cursor is current", () => {
    expect(findNextStableRelease(STABLES, "rust-v0.3.0")).toBeNull();
  });

  test("fails instead of skipping an unavailable cursor", () => {
    expect(() => findNextStableRelease(STABLES, "rust-v0.0.9")).toThrow(
      "Could not find terminal release rust-v0.0.9",
    );
  });
});
