import {
  findLatestStableReleaseAfter,
  listStableReleases,
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

describe("Codex GitHub release fetch", () => {
  test("retries a server error before succeeding", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const releases = await listStableReleases({
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) {
          return new Response("Gateway Timeout", { status: 504 });
        }
        return new Response(JSON.stringify(STABLES), { status: 200 });
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(requests).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(releases).toEqual(STABLES);
  });

  test("retries a network error before succeeding", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const releases = await listStableReleases({
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) throw new TypeError("fetch failed: ECONNRESET");
        return new Response(JSON.stringify(STABLES), { status: 200 });
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(requests).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(releases).toEqual(STABLES);
  });

  test("stops after the bounded retry budget", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const result = listStableReleases({
      fetchImpl: (async () => {
        requests++;
        return new Response("Gateway Timeout", { status: 504 });
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    await expect(result).rejects.toThrow(
      "GitHub releases API failed (504): Gateway Timeout",
    );
    expect(requests).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("fails immediately on a client error", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const result = listStableReleases({
      fetchImpl: (async () => {
        requests++;
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    await expect(result).rejects.toThrow(
      "GitHub releases API failed (404): Not Found",
    );
    expect(requests).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
