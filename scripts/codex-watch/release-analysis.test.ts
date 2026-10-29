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
  test("resolves latest without fetching a list page when the cursor is current", async () => {
    const urls: string[] = [];
    const releases = await listStableReleases({
      sinceTag: "rust-v0.3.0",
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return Response.json(STABLES[2]);
      }) as typeof fetch,
    });

    expect(releases).toEqual([STABLES[2]]);
    expect(urls).toEqual([
      "https://api.github.com/repos/openai/codex/releases/latest",
    ]);
  });

  test("resolves an explicit current tag without fetching a list page", async () => {
    const urls: string[] = [];
    const releases = await listStableReleases({
      currentTag: "rust-v0.2.0",
      sinceTag: "rust-v0.2.0",
      fetchImpl: (async (input) => {
        const url = String(input);
        urls.push(url);
        return Response.json(url.endsWith("/latest") ? STABLES[2] : STABLES[1]);
      }) as typeof fetch,
    });

    expect(releases).toEqual([STABLES[1], STABLES[2]]);
    expect(urls).toEqual([
      "https://api.github.com/repos/openai/codex/releases/latest",
      "https://api.github.com/repos/openai/codex/releases/tags/rust-v0.2.0",
    ]);
  });

  test("bounds pagination after finding the adjacent stable release", async () => {
    const urls: string[] = [];
    const prereleases = Array.from({ length: 100 }, (_, index) => ({
      ...release(
        `rust-v1.0.${index}`,
        `2026-09-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
      ),
      prerelease: true,
    }));
    const releases = await listStableReleases({
      fetchImpl: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/latest")) return Response.json(STABLES[2]);
        if (url.endsWith("page=1")) return Response.json(prereleases);
        if (url.endsWith("page=2")) return Response.json([STABLES[1]]);
        throw new Error(`Unexpected request ${url}`);
      }) as typeof fetch,
    });

    expect(releases).toEqual([STABLES[1], STABLES[2]]);
    expect(urls.filter((url) => url.includes("?per_page=100"))).toHaveLength(2);
  });

  test("stops range pagination as soon as the since tag is found", async () => {
    const urls: string[] = [];
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      ...release(
        `rust-v1.0.${index}`,
        `2026-09-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
      ),
      prerelease: true,
    }));
    await listStableReleases({
      currentTag: "rust-v0.3.0",
      sinceTag: "rust-v0.1.0",
      fetchImpl: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/latest")) return Response.json(STABLES[2]);
        if (url.endsWith("/tags/rust-v0.3.0")) return Response.json(STABLES[2]);
        if (url.endsWith("page=1")) return Response.json(fullPage);
        if (url.endsWith("page=2")) return Response.json(STABLES.slice(0, 2));
        throw new Error(`Unexpected request ${url}`);
      }) as typeof fetch,
    });

    expect(urls.filter((url) => url.includes("?per_page=100"))).toHaveLength(2);
  });

  test("reports a missing explicit current tag without listing releases", async () => {
    const urls: string[] = [];
    const result = listStableReleases({
      currentTag: "rust-v9.9.9",
      fetchImpl: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/latest")) return Response.json(STABLES[2]);
        return new Response("Not Found", { status: 404 });
      }) as typeof fetch,
    });

    await expect(result).rejects.toThrow(
      "GitHub releases API failed (404): Not Found",
    );
    expect(urls.some((url) => url.includes("?per_page=100"))).toBe(false);
  });

  test("retries a server error before succeeding", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const releases = await listStableReleases({
      sinceTag: "rust-v0.3.0",
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) {
          return new Response("Gateway Timeout", { status: 504 });
        }
        return Response.json(STABLES[2]);
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(requests).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(releases).toEqual([STABLES[2]]);
  });

  test("retries a network error before succeeding", async () => {
    const sleeps: number[] = [];
    let requests = 0;

    const releases = await listStableReleases({
      sinceTag: "rust-v0.3.0",
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) throw new TypeError("fetch failed: ECONNRESET");
        return Response.json(STABLES[2]);
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(requests).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(releases).toEqual([STABLES[2]]);
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

  test("retries a disconnected successful response body", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const releases = await listStableReleases({
      sinceTag: "rust-v0.3.0",
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) {
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError("fetch failed: ECONNRESET"));
              },
            }),
            { status: 200 },
          );
        }
        return Response.json(STABLES[2]);
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(requests).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(releases).toEqual([STABLES[2]]);
  });

  test("stops retrying disconnected bodies at the existing budget", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const result = listStableReleases({
      fetchImpl: (async () => {
        requests++;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("fetch failed: ECONNRESET"));
            },
          }),
        );
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    await expect(result).rejects.toThrow("after 3 attempts");
    expect(requests).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("does not retry malformed JSON", async () => {
    const sleeps: number[] = [];
    let requests = 0;
    const result = listStableReleases({
      fetchImpl: (async () => {
        requests++;
        return new Response("not JSON");
      }) as typeof fetch,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    await expect(result).rejects.toBeInstanceOf(SyntaxError);
    expect(requests).toBe(1);
    expect(sleeps).toEqual([]);
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
