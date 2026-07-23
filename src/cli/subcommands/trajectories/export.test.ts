import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileTimestamp,
  listAllTrajectories,
  runTrajectoryExport,
  sessionHash,
} from "@/cli/subcommands/trajectories/export";
import { listSupportedSources } from "@/cli/subcommands/trajectories/sources";

const CLAUDE_CODE_SESSION = [
  JSON.stringify({
    type: "user",
    uuid: "u1",
    parentUuid: null,
    cwd: "/workspace/project",
    timestamp: "2026-03-06T14:15:22.394Z",
    message: { role: "user", content: "fix the flaky retry test" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-03-06T14:15:30.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [
        { type: "text", text: "Looking at retry.py now." },
        {
          type: "tool_use",
          id: "toolu_01A",
          name: "Read",
          input: { file_path: "retry.py" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "u2",
    timestamp: "2026-03-06T14:15:31.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01A",
          content: [{ type: "text", text: "1\tdef retry():" }],
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-03-06T14:15:33.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "Patched the backoff." }],
    },
  }),
].join("\n");

const CODEX_SESSION = [
  JSON.stringify({
    timestamp: "2026-03-30T05:38:34.432Z",
    type: "session_meta",
    payload: {
      id: "s1",
      cwd: "/workspace/other",
      timestamp: "2026-03-30T05:38:34.432Z",
    },
  }),
  JSON.stringify({
    timestamp: "2026-03-30T05:38:34.725Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "create one focused commit" }],
    },
  }),
  JSON.stringify({
    timestamp: "2026-03-30T05:40:43.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Created one focused commit." }],
    },
  }),
].join("\n");

const LETTA_SESSION = [
  JSON.stringify({
    kind: "user",
    text: "hello there",
    captured_at: "2026-07-01T12:00:00Z",
    source_message_id: "message-1",
  }),
  JSON.stringify({
    kind: "assistant",
    text: "hi, done.",
    captured_at: "2026-07-01T12:00:05Z",
    source_message_id: "message-2",
  }),
].join("\n");

const OPENHANDS_EVENTS = [
  {
    kind: "MessageEvent",
    id: "m1",
    timestamp: "2026-07-03T10:00:00",
    source: "user",
    llm_message: {
      role: "user",
      content: [{ type: "text", text: "inspect the entry point" }],
    },
  },
  {
    kind: "MessageEvent",
    id: "m2",
    timestamp: "2026-07-03T10:00:05",
    source: "agent",
    llm_message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  },
];

type SeededRoots = Record<string, string>;

const SEEDED_SOURCES = [
  "claude-code",
  "codex",
  "letta-code",
  "openhands",
  "hermes",
];

async function seedStores(baseDir: string): Promise<SeededRoots> {
  const claudeRoot = join(baseDir, "claude-projects");
  const claudeProject = join(claudeRoot, "-workspace-project");
  await mkdir(claudeProject, { recursive: true });
  await writeFile(
    join(claudeProject, "session-abc.jsonl"),
    CLAUDE_CODE_SESSION,
  );

  const codexRoot = join(baseDir, "codex-sessions");
  const codexDay = join(codexRoot, "2026", "03", "30");
  await mkdir(codexDay, { recursive: true });
  await writeFile(join(codexDay, "rollout-2026-03-30-s1.jsonl"), CODEX_SESSION);

  const lettaRoot = join(baseDir, "letta-transcripts");
  const lettaConversation = join(
    lettaRoot,
    "agent-local-1",
    "conversation-local-1",
  );
  await mkdir(lettaConversation, { recursive: true });
  await writeFile(join(lettaConversation, "transcript.jsonl"), LETTA_SESSION);

  const openhandsRoot = join(baseDir, "openhands-sessions");
  const eventsDir = join(openhandsRoot, "conv-1", "events");
  await mkdir(eventsDir, { recursive: true });
  for (const [index, event] of OPENHANDS_EVENTS.entries()) {
    await writeFile(join(eventsDir, `${index}.json`), JSON.stringify(event));
  }

  const hermesRoot = join(baseDir, "hermes");
  await mkdir(hermesRoot, { recursive: true });
  const hermesDb = join(hermesRoot, "state.db");
  seedHermesStore(hermesDb);

  return {
    "claude-code": claudeRoot,
    codex: codexRoot,
    "letta-code": lettaRoot,
    openhands: openhandsRoot,
    hermes: hermesDb,
  };
}

function seedHermesStore(path: string): void {
  const db = new Database(path);
  db.run(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, system_prompt TEXT, started_at REAL, ended_at REAL, title TEXT)",
  );
  db.run(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, reasoning TEXT, reasoning_content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, finish_reason TEXT, timestamp REAL, observed INTEGER, active INTEGER)",
  );
  db.run(
    "INSERT INTO sessions (id, source, model, cwd, started_at, title) VALUES ('hermes-1', 'tui', 'gpt-5.2', '/workspace/hermes', 1783000000.0, 'Inspect dir')",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, observed, active) VALUES ('hermes-1', 'user', 'check the directory', 1783000001.0, 0, 1)",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, observed, active) VALUES ('hermes-1', 'assistant', 'It is /workspace/hermes.', 1783000002.0, 0, 1)",
  );
  db.close();
}

describe("trajectories export", () => {
  let baseDir: string;
  let outDir: string;
  let roots: SeededRoots;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "traj-"));
    outDir = join(baseDir, "out");
    roots = await seedStores(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("exports sessions from every seeded store into one directory", async () => {
    const manifest = await runTrajectoryExport({
      outDir,
      sources: SEEDED_SOURCES,
      roots,
    });

    for (const source of SEEDED_SOURCES) {
      expect(manifest.sources[source]).toEqual({ discovered: 1, exported: 1 });
    }
    expect(manifest.errors).toEqual([]);
    expect(manifest.sessions).toHaveLength(SEEDED_SOURCES.length);

    for (const session of manifest.sessions) {
      const records = JSON.parse(
        await readFile(join(outDir, session.file), "utf-8"),
      );
      expect(records[0].role).toBe("meta");
      expect(records[0].source).toBe(session.source);
    }

    const claude = manifest.sessions.find((s) => s.source === "claude-code");
    expect(claude?.project).toBe("/workspace/project");
    expect(claude?.toolCalls).toBe(1);
    expect(claude?.firstUserPrompt).toBe("fix the flaky retry test");

    const hermes = manifest.sessions.find((s) => s.source === "hermes");
    expect(hermes?.id).toBe("hermes-1");
    expect(hermes?.project).toBe("/workspace/hermes");

    // Uniform chronological filenames: <startedAt>_<sessionId>.json, where
    // sessionId is the stable hash of the source-scoped native id.
    for (const session of manifest.sessions) {
      expect(session.sessionId).toBe(sessionHash(session.source, session.id));
      expect(session.file).toBe(
        join(
          session.source,
          `${fileTimestamp(session.startedAt)}_${session.sessionId}.json`,
        ),
      );
    }

    const written = JSON.parse(
      await readFile(join(outDir, "manifest.json"), "utf-8"),
    );
    expect(written.sessions).toHaveLength(SEEDED_SOURCES.length);
  });

  test("letta-code sessions retain their agent and conversation ids", async () => {
    const items = await listAllTrajectories("letta-code", roots["letta-code"]);
    expect(items.map((item) => item.id)).toEqual([
      "agent-local-1/conversation-local-1",
    ]);
  });

  test("filters sessions by recorded project directory", async () => {
    const manifest = await runTrajectoryExport({
      outDir,
      sources: SEEDED_SOURCES,
      roots,
      project: "/workspace/project",
    });
    expect(manifest.sessions.map((s) => s.source)).toEqual(["claude-code"]);
  });

  test("records normalization failures without aborting the export", async () => {
    const brokenDir = join(roots["claude-code"] ?? "", "-broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "empty.jsonl"), "not json\n");

    const manifest = await runTrajectoryExport({
      outDir,
      sources: SEEDED_SOURCES,
      roots,
    });
    expect(manifest.errors).toHaveLength(1);
    expect(manifest.errors[0]?.source).toBe("claude-code");
    expect(manifest.sessions).toHaveLength(SEEDED_SOURCES.length);
  });

  test("includes explicit --transcript files for any supported source", async () => {
    const transcriptPath = join(baseDir, "elsewhere.jsonl");
    await writeFile(transcriptPath, CODEX_SESSION);
    const manifest = await runTrajectoryExport({
      outDir,
      sources: ["openhands"],
      roots: { openhands: join(baseDir, "no-such-store") },
      transcripts: [{ source: "codex", path: transcriptPath }],
    });
    expect(manifest.sessions.map((s) => s.source)).toEqual(["codex"]);
    expect(manifest.sessions[0]?.id).toBe("elsewhere");
  });

  test("rejects unknown sources with the supported list", async () => {
    expect(
      runTrajectoryExport({ outDir, sources: ["not-a-source"] }),
    ).rejects.toThrow(/supports: /);
  });

  test("refuses to overwrite a non-empty directory it did not create", async () => {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "precious.txt"), "keep me");
    expect(
      runTrajectoryExport({ outDir, sources: SEEDED_SOURCES, roots }),
    ).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(join(outDir, "precious.txt"), "utf-8")).toBe(
      "keep me",
    );
  });

  test("replaces the output of a previous export", async () => {
    await runTrajectoryExport({
      outDir,
      sources: SEEDED_SOURCES,
      roots,
    });
    const manifest = await runTrajectoryExport({
      outDir,
      sources: ["codex"],
      roots,
    });
    expect(manifest.sessions).toHaveLength(1);
    const entries = await readdir(outDir);
    expect(entries.sort()).toEqual(["codex", "manifest.json"]);
  });
});

describe("listSupportedSources", () => {
  test("enumerates sources from the installed trajectory package", async () => {
    const sources = await listSupportedSources();
    for (const expected of [
      "claude-code",
      "codex",
      "deepagents",
      "hermes",
      "letta-code",
      "openclaw",
      "openhands",
    ]) {
      expect(sources).toContain(expected);
    }
  });
});

describe("fileTimestamp", () => {
  test("produces filesystem-safe stamps", () => {
    expect(fileTimestamp("2026-03-06T14:15:22.394Z")).toBe(
      "2026-03-06T14-15-22",
    );
    expect(fileTimestamp(undefined)).toBe("unknown-date");
  });
});

describe("sessionHash", () => {
  test("is deterministic and scoped by source", () => {
    expect(sessionHash("codex", "s1")).toBe(sessionHash("codex", "s1"));
    expect(sessionHash("codex", "s1")).not.toBe(
      sessionHash("letta-code", "s1"),
    );
    expect(sessionHash("codex", "s1")).toMatch(/^[0-9a-f]{10}$/);
  });
});
