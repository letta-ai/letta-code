import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const scriptsDir = join(
  repoRoot,
  "src",
  "skills",
  "builtin",
  "initializing-memory",
  "scripts",
);
// Render through the real `letta trajectories view` implementation.
const lettaCmd = `${process.execPath} ${join(repoRoot, "src", "index.ts")}`;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-init-history-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runScript(name: string, args: string[]) {
  const result = spawnSync("node", [join(scriptsDir, name), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function session(
  sessionId: string,
  file: string,
  project: string | undefined,
  startedAt: string,
  userMessages: number,
) {
  return {
    source: "codex",
    id: `native-${sessionId}`,
    sessionId,
    file,
    sourcePath: "/native",
    project,
    startedAt,
    records: 3,
    userMessages,
    assistantMessages: 1,
    toolCalls: 0,
    reasoningRecords: 0,
    bytes: 100,
    diagnostics: 0,
  };
}

function writeTrajectory(exportDir: string, file: string, text: string) {
  const path = join(exportDir, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify([
      { role: "meta", source: "codex", cwd: "/r" },
      { role: "user", content: text, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "ok", timestamp: "2026-01-01T00:00:01Z" },
    ]),
  );
}

// Export with two renderable sessions in one existing project, one session
// without user messages, one whose file is missing, and one export error.
function makeExport(project: string): string {
  const exportDir = makeTempDir();
  writeTrajectory(exportDir, "codex/a.json", "always use uv");
  writeTrajectory(exportDir, "codex/b.json", "never push to main");
  writeTrajectory(exportDir, "codex/c.json", "unused");
  writeFileSync(
    join(exportDir, "manifest.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-01-02T00:00:00Z",
      outDir: exportDir,
      sources: { codex: { discovered: 5, exported: 4 } },
      errors: [{ source: "codex", sourcePath: "/bad", error: "no turns" }],
      sessions: [
        session("aaaa", "codex/a.json", project, "2026-01-01T09:00:00Z", 2),
        session("bbbb", "codex/b.json", project, "2026-01-03T09:00:00Z", 1),
        session("cccc", "codex/c.json", project, "2026-01-04T09:00:00Z", 0),
        session("dddd", "codex/missing.json", undefined, "2026-01-05", 1),
      ],
    }),
  );
  return exportDir;
}

function prepare(exportDir: string, extra: string[] = []) {
  const outDir = makeTempDir();
  const result = runScript("prepare-history.mjs", [
    "--export",
    exportDir,
    "--out",
    outDir,
    "--letta",
    lettaCmd,
    ...extra,
  ]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return outDir;
}

type Cohort = {
  id: string;
  repo: string | null;
  sessions: Array<{ sessionId: string; path: string; project: string }>;
};

function readCohorts(outDir: string): Cohort[] {
  return JSON.parse(readFileSync(join(outDir, "cohorts.json"), "utf8"))
    .historyCohorts;
}

describe("prepare-history.mjs", () => {
  test("renders sessions, builds cohorts, and records exclusions", () => {
    const project = makeTempDir();
    const outDir = prepare(makeExport(project));

    const cohorts = readCohorts(outDir);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]?.repo).toBe(project);
    expect(cohorts[0]?.sessions.map((s) => s.sessionId)).toEqual([
      "aaaa",
      "bbbb",
    ]);
    const rendered = readFileSync(cohorts[0]?.sessions[0]?.path ?? "", "utf8");
    expect(rendered).toContain(">>> USER");
    expect(rendered).toContain("always use uv");

    const ledger = JSON.parse(
      readFileSync(join(outDir, "ledger.json"), "utf8"),
    );
    expect(ledger.manifestSessions).toBe(4);
    expect(ledger.assigned).toBe(2);
    expect(ledger.exportErrors).toHaveLength(1);
    expect(
      ledger.excluded.map((e: { sessionId: string; reason: string }) => [
        e.sessionId,
        e.reason.split(":")[0],
      ]),
    ).toEqual([
      ["cccc", "no user messages"],
      ["dddd", "render failed"],
    ]);
  });

  test("splits cohorts at the session cap with unique ids", () => {
    const project = makeTempDir();
    const outDir = prepare(makeExport(project), ["--max-sessions", "1"]);

    const cohorts = readCohorts(outDir);
    expect(cohorts.map((c) => c.sessions.length)).toEqual([1, 1]);
    expect(new Set(cohorts.map((c) => c.id)).size).toBe(2);
  });

  test("fails with guidance when the export has no manifest", () => {
    const result = runScript("prepare-history.mjs", [
      "--export",
      makeTempDir(),
      "--out",
      makeTempDir(),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("letta trajectories export");
  });
});

describe("history-coverage.mjs", () => {
  function writeJournal(entries: unknown[]): string {
    const path = join(makeTempDir(), "journal.jsonl");
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
    return path;
  }

  test("reports unread sessions and writes retry cohorts", () => {
    const outDir = prepare(makeExport(makeTempDir()));
    const journal = writeJournal([
      {
        callIndex: 0,
        label: "history:x",
        outcome: { failed: false, value: { sessionsRead: ["aaaa"] } },
      },
      {
        callIndex: 1,
        label: "history:y",
        outcome: { failed: true, value: { sessionsRead: ["bbbb"] } },
      },
    ]);
    const retryOut = join(makeTempDir(), "retry.json");

    const result = runScript("history-coverage.mjs", [
      "--prepared",
      outDir,
      "--journal",
      journal,
      "--retry-out",
      retryOut,
    ]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.analyzed).toBe(1);
    expect(report.excluded).toBe(2);
    expect(report.exportErrors).toBe(1);
    expect(report.allAssignedRead).toBe(false);
    expect(report.unread[0].sessionIds).toEqual(["bbbb"]);

    const retry = JSON.parse(readFileSync(retryOut, "utf8")).historyCohorts;
    expect(retry).toHaveLength(1);
    expect(
      retry[0].sessions.map((s: { sessionId: string }) => s.sessionId),
    ).toEqual(["bbbb"]);
  });

  test("combines follow-up journals and flags sessions dropped by hand", () => {
    const outDir = prepare(makeExport(makeTempDir()));
    const first = writeJournal([
      { outcome: { failed: false, value: { sessionsRead: ["aaaa"] } } },
    ]);
    const second = writeJournal([
      { outcome: { failed: false, value: { sessionsRead: ["bbbb"] } } },
    ]);

    const complete = JSON.parse(
      runScript("history-coverage.mjs", [
        "--prepared",
        outDir,
        "--journal",
        first,
        "--journal",
        second,
      ]).stdout,
    );
    expect(complete.analyzed).toBe(2);
    expect(complete.allAssignedRead).toBe(true);

    const cohortsPath = join(outDir, "cohorts.json");
    const cohorts = readCohorts(outDir);
    const firstCohort = cohorts[0];
    if (!firstCohort) throw new Error("expected a cohort");
    firstCohort.sessions = firstCohort.sessions.slice(0, 1);
    writeFileSync(cohortsPath, JSON.stringify({ historyCohorts: cohorts }));

    const dropped = JSON.parse(
      runScript("history-coverage.mjs", [
        "--prepared",
        outDir,
        "--journal",
        first,
      ]).stdout,
    );
    expect(dropped.droppedFromCohorts).toBe(1);
    expect(dropped.allAssignedRead).toBe(false);
  });
});
