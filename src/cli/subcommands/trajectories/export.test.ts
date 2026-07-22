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
  listAllTrajectories,
  partitionSessions,
  runTrajectoryExport,
  sanitizeSessionId,
} from "@/cli/subcommands/trajectories/export";
import { listSupportedSources } from "@/cli/subcommands/trajectories/sources";
import type { SessionManifestEntry } from "@/cli/subcommands/trajectories/types";

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
    role: "user",
    content: "hello there",
    date: "2026-07-01T12:00:00Z",
  }),
  JSON.stringify({
    role: "assistant",
    content: "hi, done.",
    date: "2026-07-01T12:00:05Z",
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

const SEEDED_SOURCES = ["claude-code", "codex", "letta", "openhands", "hermes"];

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

  const lettaRoot = join(baseDir, "letta-conversations");
  const conversationKey = Buffer.from("conversation:local-conv-1").toString(
    "base64url",
  );
  const lettaConversation = join(lettaRoot, conversationKey);
  await mkdir(lettaConversation, { recursive: true });
  await writeFile(join(lettaConversation, "messages.jsonl"), LETTA_SESSION);

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
    letta: lettaRoot,
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

    const written = JSON.parse(
      await readFile(join(outDir, "manifest.json"), "utf-8"),
    );
    expect(written.sessions).toHaveLength(SEEDED_SOURCES.length);
  });

  test("letta sessions keep their decoded conversation ids", async () => {
    const items = await listAllTrajectories("letta", roots.letta);
    expect(items.map((item) => item.id)).toEqual(["conversation:local-conv-1"]);
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

  test("writes balanced worker chunk files covering every session", async () => {
    const manifest = await runTrajectoryExport({
      outDir,
      sources: SEEDED_SOURCES,
      roots,
      chunks: 2,
    });
    expect(manifest.chunks).toHaveLength(2);

    const chunked: string[] = [];
    for (const chunkFile of manifest.chunks ?? []) {
      const chunk = JSON.parse(
        await readFile(join(outDir, chunkFile), "utf-8"),
      );
      chunked.push(...chunk.sessions.map((s: SessionManifestEntry) => s.file));
    }
    expect(chunked.sort()).toEqual(manifest.sessions.map((s) => s.file).sort());
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
      chunks: 3,
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
      "letta",
      "openclaw",
      "openhands",
    ]) {
      expect(sources).toContain(expected);
    }
  });
});

describe("partitionSessions", () => {
  const session = (file: string, bytes: number): SessionManifestEntry => ({
    source: "codex",
    id: file,
    file,
    sourcePath: `/tmp/${file}`,
    records: 1,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    reasoningRecords: 0,
    bytes,
    diagnostics: 0,
  });

  test("balances sessions across chunks by size", () => {
    const partitions = partitionSessions(
      [session("a", 100), session("b", 60), session("c", 50), session("d", 10)],
      2,
    );
    expect(partitions).toHaveLength(2);
    const totals = partitions.map((p) =>
      p.reduce((sum, s) => sum + s.bytes, 0),
    );
    expect(Math.max(...totals)).toBeLessThanOrEqual(120);
  });

  test("never returns more chunks than sessions", () => {
    const partitions = partitionSessions([session("a", 1)], 5);
    expect(partitions).toHaveLength(1);
  });
});

describe("sanitizeSessionId", () => {
  test("produces filesystem-safe names", () => {
    expect(sanitizeSessionId("conversation:local/conv 1")).toBe(
      "conversation-local-conv-1",
    );
    expect(sanitizeSessionId("...")).toBe("session");
  });
});
