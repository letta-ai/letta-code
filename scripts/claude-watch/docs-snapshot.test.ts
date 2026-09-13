import { describe, expect, test } from "bun:test";
import {
  captureDocsSnapshot,
  deterministicSourcePath,
  diffDocsSnapshots,
  extractNamedChanges,
  hashDocsMarkdown,
  isWatchedDocsUrl,
  normalizeDocsMarkdown,
  parseLlmsTxt,
  sha256,
  unifiedDiff,
} from "./docs-snapshot.ts";
import type { ClaudeDocsSnapshot } from "./types.ts";

const INDEX = "https://docs.example/llms.txt";
const TOOLS = "https://docs.example/en/tools.md";
const GUIDE = "https://docs.example/en/guide.md";

function fixtureFetch(
  fixtures: Record<string, string>,
  calls: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = fixtures[url];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe("official docs capture", () => {
  test("parses every unique absolute .md URL from llms.txt", () => {
    expect(
      parseLlmsTxt(
        `- [Tools](${TOOLS})\n${GUIDE}?raw=1#part\nrelative.md\nhttps://docs.example/nope.html\n${TOOLS}`,
      ),
    ).toEqual([`${GUIDE}?raw=1`, TOOLS]);
  });

  test("treats the official changelog as watched contract evidence", () => {
    expect(
      isWatchedDocsUrl(
        "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
      ),
    ).toBe(true);
  });

  test("semantic normalization preserves markdown while removing transport noise", () => {
    const source =
      "# Claude Code Docs  \r\n\r\n# Heading\t\r\n| parameter_name | Value |  \r\n| --- | --- |\r\n| `exactName` |  x  |\r\n```sh\r\nclaude --flag  \r\n```\r\n# Claude Code Docs\r\n";
    expect(normalizeDocsMarkdown(source)).toBe(
      "# Claude Code Docs\n\n# Heading\n| parameter_name | Value |\n| --- | --- |\n| `exactName` |  x  |\n```sh\nclaude --flag\n```\n",
    );
  });

  test("hashes exact normalized UTF-8 content", () => {
    expect(hashDocsMarkdown("hello  \r\n")).toBe(sha256("hello\n"));
    expect(hashDocsMarkdown("Hello\n")).not.toBe(hashDocsMarkdown("hello\n"));
  });

  test("full capture persists only watched normalized sources deterministically", async () => {
    const captured = await captureDocsSnapshot({
      indexUrl: INDEX,
      now: "2026-01-01T00:00:00Z",
      fetch: fixtureFetch({
        [INDEX]: `${GUIDE}\n${TOOLS}\n`,
        [TOOLS]: "# Tools  \r\n",
        [GUIDE]: "# Guide\n",
      }),
    });
    expect(captured.snapshot.full_scan).toBe(true);
    expect(Object.keys(captured.snapshot.pages)).toEqual([GUIDE, TOOLS]);
    const path = deterministicSourcePath(TOOLS);
    expect(captured.snapshot.pages[TOOLS]?.source_path).toBe(path);
    expect(captured.snapshot.pages[GUIDE]?.source_path).toBeNull();
    expect(captured.sources).toEqual({
      "sources/llms.txt": `${GUIDE}\n${TOOLS}\n`,
      [path]: "# Tools\n",
    });
  });

  test("refuses indexed and redirected pages outside the authoritative docs origin", async () => {
    await expect(
      captureDocsSnapshot({
        indexUrl: INDEX,
        retries: 0,
        fetch: fixtureFetch({
          [INDEX]: "https://127.0.0.1/internal.md",
        }),
      }),
    ).rejects.toThrow("outside https://docs.example");

    const redirectingFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === INDEX) return new Response(TOOLS);
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/metadata.md" },
      });
    }) as typeof fetch;
    await expect(
      captureDocsSnapshot({
        indexUrl: INDEX,
        retries: 0,
        fetch: redirectingFetch,
      }),
    ).rejects.toThrow("outside https://docs.example");
  });

  test("detects added, removed, and changed pages with watched source previews", async () => {
    const oldCapture = await captureDocsSnapshot({
      indexUrl: INDEX,
      now: "2026-01-01T00:00:00Z",
      fetch: fixtureFetch({
        [INDEX]: `${TOOLS}\n${GUIDE}`,
        [TOOLS]: "# Tools\nold\n",
        [GUIDE]: "old",
      }),
    });
    const added = "https://docs.example/en/hooks.md";
    const current = await captureDocsSnapshot({
      indexUrl: INDEX,
      now: "2026-01-02T01:00:00Z",
      fetch: fixtureFetch({
        [INDEX]: `${TOOLS}\n${added}`,
        [TOOLS]: "# Tools\nnew\n",
        [added]: "# Hooks\n",
      }),
      previous: oldCapture.snapshot,
      forceFullScan: true,
    });
    const diff = diffDocsSnapshots(oldCapture.snapshot, current.snapshot, {
      previousSources: oldCapture.sources,
      currentSources: current.sources,
    });
    expect(diff.added_pages).toEqual([added]);
    expect(diff.removed_pages).toEqual([GUIDE]);
    expect(diff.changed_pages).toEqual([TOOLS]);
    expect(diff.watched_page_diffs[0]?.preview).toContain(
      `--- a/${deterministicSourcePath(added)}`,
    );
  });

  test("digest is stable when only scan metadata changes", async () => {
    const fixtures = { [INDEX]: TOOLS, [TOOLS]: "# Tools\n" };
    const first = await captureDocsSnapshot({
      indexUrl: INDEX,
      now: 0,
      fetch: fixtureFetch(fixtures),
    });
    const second = await captureDocsSnapshot({
      indexUrl: INDEX,
      now: 1000,
      fetch: fixtureFetch(fixtures),
      forceFullScan: true,
    });
    expect(second.snapshot.digest).toBe(first.snapshot.digest);
  });

  test("extracts named surfaces only from strongly labelled contexts", () => {
    const named = extractNamedChanges(
      `# Tools\n| Tool | Description |\n| --- | --- |\n| Read | reads |\n\n# CLI flags and commands\nUse \`--verbose\` and \`claude doctor\`.\n\n# Settings\n\`sandbox.enabled\`\n\n# Environment variables\n\`CLAUDE_CODE_TOKEN\`\n\n# Permissions\n\`allow(Bash)\`\n\n# Narrative\n\`NOT_AN_ENV\``,
    );
    expect([...named.tools]).toEqual(["Read"]);
    expect([...named.cli].sort()).toEqual(["--verbose", "claude doctor"]);
    expect([...named.settings]).toEqual(["sandbox.enabled"]);
    expect([...named.env_vars]).toEqual(["CLAUDE_CODE_TOKEN"]);
    expect([...named.permission_rules]).toEqual(["allow(Bash)"]);
  });

  test("reports conservative named additions and removals", () => {
    const path = deterministicSourcePath(TOOLS);
    const previous = snapshot({
      [TOOLS]: { url: TOOLS, watched: true, source_path: path, hash: "old" },
    });
    const current = snapshot({
      [TOOLS]: { url: TOOLS, watched: true, source_path: path, hash: "new" },
    });
    const diff = diffDocsSnapshots(previous, current, {
      previousSources: {
        [path]:
          "# Tools\n| Tool | Description |\n| --- | --- |\n| Read | old |\n",
      },
      currentSources: {
        [path]:
          "# Tools\n| Tool | Description |\n| --- | --- |\n| Write | new |\n",
      },
    });
    expect(diff.tools).toEqual({
      added: ["Write"],
      removed: ["Read"],
      changed: [],
    });
  });

  test("bounds diff previews with explicit truncation marker and source path", () => {
    const result = unifiedDiff(
      "a\nb\nc\nd\n",
      "a\nx\ny\nz\n",
      "docs/source.md",
      6,
      10_000,
    );
    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("--- a/docs/source.md");
    expect(result.preview).toContain("[diff truncated:");
  });

  test("incremental capture fetches index and watched pages and reuses unwatched hashes", async () => {
    const previous = snapshot(
      {
        [TOOLS]: {
          url: TOOLS,
          watched: true,
          source_path: deterministicSourcePath(TOOLS),
          hash: "old-tool",
        },
        [GUIDE]: {
          url: GUIDE,
          watched: false,
          source_path: null,
          hash: "reused-guide",
        },
      },
      "2026-01-01T12:00:00Z",
    );
    const calls: string[] = [];
    const result = await captureDocsSnapshot({
      indexUrl: INDEX,
      previous,
      now: "2026-01-01T13:00:00Z",
      fetch: fixtureFetch(
        { [INDEX]: `${TOOLS}\n${GUIDE}`, [TOOLS]: "# Tools\nchanged\n" },
        calls,
      ),
      retries: 0,
    });
    expect(result.snapshot.full_scan).toBe(false);
    expect(calls).toEqual([INDEX, TOOLS]);
    expect(result.snapshot.pages[GUIDE]?.hash).toBe("reused-guide");
  });
});

function snapshot(
  pages: ClaudeDocsSnapshot["pages"],
  scannedAt = "2026-01-01T00:00:00Z",
): ClaudeDocsSnapshot {
  return {
    index_url: INDEX,
    index_hash: "index",
    digest: "digest",
    full_scan: true,
    scanned_at: scannedAt,
    pages,
  };
}
