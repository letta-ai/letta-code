import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeClaudeCandidate,
  buildClaudeCandidateId,
} from "./release-analysis.ts";
import type {
  ClaudeDocsSnapshot,
  ClaudeProbeObservation,
  ClaudeReleaseCandidate,
  ClaudeRuntimeSnapshot,
  ClaudeWatchStateSnapshot,
  ClaudeWatchVerdict,
} from "./types.ts";

interface ReplayFixture {
  id: string;
  previous_version: string;
  current_version: string;
  previous_tools: string[];
  current_tools: string[];
  probe_name: string;
  previous_result: string;
  current_result: string;
  expected_verdict: ClaudeWatchVerdict;
  local_surfaces: string[];
}

const fixtures = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "historical-replays.json"),
    "utf8",
  ),
) as ReplayFixture[];

function docs(digest = "docs-stable"): ClaudeDocsSnapshot {
  return {
    index_url: "https://code.claude.com/docs/llms.txt",
    index_hash: "index",
    digest,
    full_scan: true,
    scanned_at: "2026-08-01T00:00:00Z",
    pages: {},
  };
}

function probe(name: string, result: string): ClaudeProbeObservation {
  return {
    name,
    status: "passed",
    attempts: 1,
    assertions: { observed_result: result },
    tool_calls: [],
    tool_results: [result],
    filesystem_changes: [],
    error: null,
  };
}

function runtime(
  version: string,
  tools: string[],
  observation: ClaudeProbeObservation,
): ClaudeRuntimeSnapshot {
  return {
    version,
    version_output: `${version} (Claude Code)`,
    help_text: "--permission-mode <mode>",
    help_hash: "help",
    doctor: { exit_code: 0, summary: "No installation issues found." },
    auto_mode_defaults: {},
    init: {
      tools,
      model: "claude-test",
      capabilities: null,
      stable_fields: {},
    },
    event_inventory: ["assistant", "system/init", "user"],
    probes: [observation],
    digest: `${version}-runtime`,
  };
}

function candidate(version: string): ClaudeReleaseCandidate {
  return {
    version,
    published_at: "2026-08-01T00:00:00Z",
    integrity: `sha512-${version}`,
    tarball_url: `https://registry.npmjs.org/${version}.tgz`,
    release_url: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
    release_notes_md: "Observable Claude Code harness behavior changed.",
    release_published_at: "2026-08-01T00:01:00Z",
    dist_tags: { latest: version, stable: version, next: null },
  };
}

function previousState(
  version: string,
  previousRuntime: ClaudeRuntimeSnapshot,
): ClaudeWatchStateSnapshot {
  return {
    schema_version: 1,
    candidate_id: buildClaudeCandidateId(
      version,
      docs().digest,
      previousRuntime.digest,
    ),
    package_version: version,
    npm_integrity: `sha512-${version}`,
    npm_published_at: "2026-08-01T00:00:00Z",
    release_url: `https://github.com/anthropics/claude-code/releases/tag/v${version}`,
    release_notes_md: "previous",
    release_published_at: "2026-08-01T00:00:00Z",
    dist_tags: { latest: version, stable: version, next: null },
    docs: docs(),
    runtime: previousRuntime,
    fetched_at: "2026-08-01T00:00:00Z",
    workflow_run_url: "https://example.test/actions/1",
    state_commit_parent: null,
  };
}

describe("historical Claude parity routing fixtures", () => {
  for (const fixture of fixtures) {
    test(`${fixture.id} routes captured evidence to semantic review`, () => {
      const oldRuntime = runtime(
        fixture.previous_version,
        fixture.previous_tools,
        probe(fixture.probe_name, fixture.previous_result),
      );
      const currentRuntime = runtime(
        fixture.current_version,
        fixture.current_tools,
        probe(fixture.probe_name, fixture.current_result),
      );
      const analysis = analyzeClaudeCandidate({
        candidate: candidate(fixture.current_version),
        previous: previousState(fixture.previous_version, oldRuntime),
        currentDocs: docs(),
        currentRuntime,
        workflowRunUrl: "https://example.test/actions/2",
        stateBaseSha: "state-parent",
      });

      expect(analysis.verdict).toBe(fixture.expected_verdict);
      expect(fixture.local_surfaces.length).toBeGreaterThan(0);
    });
  }
});

describe("Claude verdict routing", () => {
  test("bootstrap requires a current-vs-local audit", () => {
    const currentRuntime = runtime(
      "2.1.237",
      ["Read"],
      probe("read-lines-9-10-tab-prefix", "9\tline9\n10\tline10"),
    );
    const analysis = analyzeClaudeCandidate({
      candidate: candidate("2.1.237"),
      previous: null,
      currentDocs: docs(),
      currentRuntime,
      workflowRunUrl: "https://example.test/actions/bootstrap",
      stateBaseSha: null,
    });

    expect(analysis.verdict).toBe("manual review required");
    expect(analysis.runtime_snapshot?.init?.tools).toEqual(["Read"]);
  });

  test("inconclusive behavioral probes require manual review", () => {
    const old = runtime(
      "2.1.236",
      ["Read"],
      probe("read-lines-9-10-tab-prefix", "old"),
    );
    const inconclusive = runtime("2.1.237", ["Read"], {
      ...probe("read-lines-9-10-tab-prefix", ""),
      status: "inconclusive",
      error: "model did not call Read",
    });
    const analysis = analyzeClaudeCandidate({
      candidate: candidate("2.1.237"),
      previous: previousState("2.1.236", old),
      currentDocs: docs(),
      currentRuntime: inconclusive,
      workflowRunUrl: "https://example.test/actions/3",
      stateBaseSha: "parent",
    });
    expect(analysis.verdict).toBe("manual review required");
    expect(analysis.verdict_reasons[0]).toContain("inconclusive");
  });

  test("an unwatched docs-only digest change still receives semantic review", () => {
    const stableRuntime = runtime(
      "2.1.237",
      ["Read"],
      probe("read-lines-9-10-tab-prefix", "stable"),
    );
    const previous = previousState("2.1.237", stableRuntime);
    previous.docs = {
      ...docs("old-docs"),
      pages: {
        "https://code.claude.com/docs/en/billing.md": {
          url: "https://code.claude.com/docs/en/billing.md",
          hash: "old",
          watched: false,
          source_path: null,
        },
      },
    };
    const currentDocs = {
      ...docs("new-docs"),
      pages: {
        "https://code.claude.com/docs/en/billing.md": {
          url: "https://code.claude.com/docs/en/billing.md",
          hash: "new",
          watched: false,
          source_path: null,
        },
      },
    };
    const analysis = analyzeClaudeCandidate({
      candidate: candidate("2.1.237"),
      previous,
      currentDocs,
      currentRuntime: stableRuntime,
      workflowRunUrl: "https://example.test/actions/4",
      stateBaseSha: "parent",
    });
    expect(analysis.verdict).toBe("harness behavior review needed");
    expect(analysis.verdict_reasons[0]).toContain("unwatched");
  });
});
