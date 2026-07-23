import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import {
  filterSessions,
  renderSession,
  resolveSessionFile,
  searchSessions,
} from "@/cli/subcommands/trajectories/review";
import type {
  SessionManifestEntry,
  TrajectoryManifest,
} from "@/cli/subcommands/trajectories/types";

const RECORDS: NormalizedRecord[] = [
  {
    role: "meta",
    source: "codex",
    cwd: "/workspace/project",
    model: "gpt-5.3-codex",
  },
  {
    role: "user",
    content: "create one focused commit",
    timestamp: "2026-03-30T05:38:34.725Z",
  },
  {
    role: "reasoning",
    content: "Reviewing the changed files",
    timestamp: "2026-03-30T05:38:45.000Z",
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_A", name: "update_plan", args: '{"a":1}' }],
    timestamp: "2026-03-30T05:38:50.441Z",
  },
  {
    role: "tool",
    tool_call_id: "call_A",
    content: "Plan updated",
    timestamp: "2026-03-30T05:38:50.585Z",
  },
  {
    role: "assistant",
    content: "Created one focused commit.",
    timestamp: "2026-03-30T05:40:43.000Z",
  },
];

function entry(overrides: Partial<SessionManifestEntry>): SessionManifestEntry {
  return {
    source: "codex",
    id: "s1",
    sessionId: "abc123def0",
    file: "codex/2026-03-30T05-38-34_abc123def0.json",
    sourcePath: "/native/s1.jsonl",
    project: "/workspace/project",
    startedAt: "2026-03-30T05:38:34.725Z",
    records: RECORDS.length,
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 1,
    reasoningRecords: 1,
    firstUserPrompt: "create one focused commit",
    bytes: 100,
    diagnostics: 0,
    ...overrides,
  };
}

describe("renderSession", () => {
  test("renders prose only by default", () => {
    const output = renderSession(RECORDS);
    expect(output).toContain("=== codex session ===");
    expect(output).toContain(">>> USER [2026-03-30T05:38:34]:");
    expect(output).toContain("Created one focused commit.");
    expect(output).not.toContain("TOOL");
    expect(output).not.toContain("REASONING");
  });

  test("includes tools and reasoning when requested", () => {
    const output = renderSession(RECORDS, { tools: true, reasoning: true });
    expect(output).toContain('update_plan({"a":1})');
    expect(output).toContain("Plan updated");
    expect(output).toContain("Reviewing the changed files");
  });
});

describe("filterSessions", () => {
  const sessions = [entry({}), entry({ source: "hermes", project: "/other" })];

  test("filters by source and project prefix", () => {
    expect(filterSessions(sessions, { source: "hermes" })).toHaveLength(1);
    expect(filterSessions(sessions, { project: "/workspace" })).toHaveLength(1);
    expect(filterSessions(sessions, {})).toHaveLength(2);
  });
});

describe("export directory reads", () => {
  let dir: string;
  const session = entry({});

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traj-review-"));
    const manifest: TrajectoryManifest = {
      version: 1,
      generatedAt: "2026-07-22T00:00:00.000Z",
      outDir: dir,
      sources: { codex: { discovered: 1, exported: 1 } },
      errors: [],
      sessions: [session],
    };
    await mkdir(join(dir, "codex"), { recursive: true });
    await writeFile(join(dir, session.file), JSON.stringify(RECORDS));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("resolveSessionFile accepts sessionId, manifest file, and path", async () => {
    const expected = join(dir, session.file);
    expect(await resolveSessionFile(dir, "abc123def0")).toBe(expected);
    expect(await resolveSessionFile(dir, session.file)).toBe(expected);
    expect(await resolveSessionFile(dir, expected)).toBe(expected);
    expect(resolveSessionFile(dir, "nope")).rejects.toThrow(/No session/);
  });

  test("searchSessions finds matches case-insensitively with role filter", async () => {
    const results = await searchSessions(dir, "FOCUSED COMMIT");
    expect(results).toHaveLength(1);
    expect(results[0]?.matches.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);

    const userOnly = await searchSessions(dir, "focused", { role: "user" });
    expect(userOnly[0]?.matches).toHaveLength(1);

    expect(await searchSessions(dir, "focused", { source: "hermes" })).toEqual(
      [],
    );
    expect(await searchSessions(dir, "no-such-phrase")).toEqual([]);
  });
});
