import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import { LocalBackend } from "@/backend/local/local-backend";
import { runTrajectoryExport } from "@/cli/subcommands/trajectories/export";
import type { TrajectoryManifest } from "@/cli/subcommands/trajectories/types";
import { importTrajectories } from "@/cli/subcommands/trajectory-import";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const records: NormalizedRecord[] = [
  { role: "meta", source: "codex", cwd: "/project", model: "gpt-5" },
  {
    role: "user",
    content: "Implement the parser",
    timestamp: "2026-03-30T01:00:00.000Z",
  },
  {
    role: "reasoning",
    content: "Check tests first",
    timestamp: "2026-03-30T01:00:01.000Z",
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call-1", name: "Read", args: '{"file_path":"/project/src.ts"}' },
    ],
    timestamp: "2026-03-30T01:00:02.000Z",
  },
  {
    role: "tool",
    tool_call_id: "call-1",
    content: "src.ts contents",
    timestamp: "2026-03-30T01:00:03.000Z",
  },
  {
    role: "assistant",
    content: "Parser implemented",
    timestamp: "2026-03-30T01:00:04.000Z",
  },
];

async function fixture(
  options: { manifest?: boolean; sessions?: number; secondBad?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "trajectory-import-test-"));
  roots.push(root);
  const storageDir = join(root, "backend");
  const dir = join(root, "export");
  await mkdir(join(dir, "codex", "nested"), { recursive: true });
  const count = options.sessions ?? 2;
  const sessions: TrajectoryManifest["sessions"] = [];
  for (let i = 0; i < count; i++) {
    const file = `codex/nested/session-${i}.json`;
    const body = JSON.stringify(
      options.secondBad && i === 1 ? [{ role: "wrong" }] : records,
    );
    await writeFile(join(dir, file), body);
    sessions.push({
      source: "codex",
      id: `native-${i}`,
      sessionId: `session-${i}`,
      file,
      sourcePath: `/native/${i}`,
      records: records.length,
      bytes: Buffer.byteLength(body),
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      reasoningRecords: 1,
      diagnostics: 0,
      firstUserPrompt: "Implement the parser",
    });
  }
  if (options.manifest !== false) {
    const manifest: TrajectoryManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      outDir: dir,
      sources: { codex: { discovered: count, exported: count } },
      errors: [],
      sessions,
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  }
  const backend = new LocalBackend({
    storageDir,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const agent = await backend.createAgent({
    name: "Blank import target",
  } as never);
  return { root, dir, backend, agent };
}

function pageItems(page: unknown): Array<Record<string, unknown>> {
  return (
    page as { getPaginatedItems(): Array<Record<string, unknown>> }
  ).getPaginatedItems();
}

describe("trajectory import through persistent local backend", () => {
  test("round-trips files emitted by the installed trajectory exporter", async () => {
    const { root, backend, agent } = await fixture({
      sessions: 0,
      manifest: false,
    });
    const transcript = join(root, "native-codex.jsonl");
    const items = [
      {
        timestamp: "2026-03-30T05:38:34.432Z",
        type: "session_meta",
        payload: {
          id: "s1",
          cwd: "/workspace/project",
          timestamp: "2026-03-30T05:38:34.432Z",
        },
      },
      {
        timestamp: "2026-03-30T05:38:34.725Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Create parser" }],
        },
      },
      {
        timestamp: "2026-03-30T05:40:43.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Parser created" }],
        },
      },
    ];
    await writeFile(
      transcript,
      items.map((item) => JSON.stringify(item)).join("\n"),
    );
    const exportDir = join(root, "actual-export");
    const manifest = await runTrajectoryExport({
      outDir: exportDir,
      sources: ["openhands"],
      roots: { openhands: join(root, "missing") },
      transcripts: [{ source: "codex", path: transcript }],
    });
    expect(manifest.errors).toEqual([]);
    expect(manifest.sessions).toHaveLength(1);
    const imported = await importTrajectories(exportDir, agent.id, backend);
    const reopened = new LocalBackend({
      storageDir: join(root, "backend"),
      memfsEnabled: false,
      executionMode: "deterministic",
    });
    const stored = pageItems(
      await reopened.listConversationMessages(
        imported.conversations[0]?.id ?? "",
        { agent_id: agent.id, order: "asc", limit: 100 } as never,
      ),
    );
    expect(stored.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(stored[0]?.content).toEqual([
      { type: "text", text: "Create parser" },
    ]);
    expect(stored[1]?.content).toEqual([
      { type: "text", text: "Parser created" },
    ]);
  });

  test("imports nested manifest sessions, preserving roles, content, tool linkage and chronology across reload", async () => {
    const { root, dir, backend, agent } = await fixture();
    const result = await importTrajectories(dir, agent.id, backend);
    expect(result.sessions).toBe(2);
    expect(result.conversations).toHaveLength(2);
    expect(result.messages).toBe(10);
    expect(backend.listAllLocalAgentConversations(agent.id)).toHaveLength(2);
    const reopened = new LocalBackend({
      storageDir: join(root, "backend"),
      memfsEnabled: false,
      executionMode: "deterministic",
    });
    const id = result.conversations[0]?.id;
    expect(id).toBeTruthy();
    const conversation = await reopened.retrieveConversation(id ?? "");
    expect(conversation.in_context_message_ids).toEqual([]);
    const stored = pageItems(
      await reopened.listConversationMessages(id ?? "", {
        agent_id: agent.id,
        order: "asc",
        limit: 100,
      } as never),
    );
    expect(stored.map((message) => message.message_type)).toEqual([
      "user_message",
      "reasoning_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]);
    expect(stored[0]?.content).toEqual([
      { type: "text", text: "Implement the parser" },
    ]);
    expect(stored[2]?.tool_call).toMatchObject({
      tool_call_id: "call-1",
      name: "Read",
    });
    expect(stored[3]?.tool_call_id).toBe("call-1");
    expect(stored[3]?.tool_return).toBe("src.ts contents");
    expect(stored[4]?.content).toEqual([
      { type: "text", text: "Parser implemented" },
    ]);
    const second = await reopened.listConversationMessages(
      result.conversations[1]?.id ?? "",
      { agent_id: agent.id, order: "asc", limit: 100 } as never,
    );
    expect(pageItems(second)).toHaveLength(5);
    await expect(importTrajectories(dir, agent.id, reopened)).rejects.toThrow(
      "already contains imported trajectories",
    );
    const other = await reopened.createAgent({
      name: "Another blank agent",
    } as never);
    const repeated = await importTrajectories(dir, other.id, reopened);
    const otherMessages = pageItems(
      await reopened.listConversationMessages(
        repeated.conversations[0]?.id ?? "",
        { agent_id: other.id, order: "asc", limit: 100 } as never,
      ),
    );
    expect(otherMessages[0]?.id).not.toBe(stored[0]?.id);
  });

  test("validates all files before writing, rejecting bad records and manifest export errors", async () => {
    const { dir, backend, agent } = await fixture({ secondBad: true });
    await expect(importTrajectories(dir, agent.id, backend)).rejects.toThrow(
      "Invalid",
    );
    expect(backend.listAllLocalAgentConversations(agent.id)).toEqual([]);
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(
      await readFile(path, "utf8"),
    ) as TrajectoryManifest;
    manifest.errors = [
      { source: "codex", sourcePath: "/native/bad", error: "failure" },
    ];
    await writeFile(path, JSON.stringify(manifest));
    await expect(importTrajectories(dir, agent.id, backend)).rejects.toThrow(
      "error(s)",
    );
    expect(backend.listAllLocalAgentConversations(agent.id)).toEqual([]);
  });

  test("manifestless scratch index is accepted by the existing history cohorter", async () => {
    const { root, dir, backend, agent } = await fixture({
      manifest: false,
      sessions: 1,
    });
    const result = await importTrajectories(dir, agent.id, backend);
    const overlay = join(root, "scratch-index");
    await mkdir(overlay);
    await symlink(join(dir, "codex"), join(overlay, "codex"), "dir");
    await writeFile(
      join(overlay, "manifest.json"),
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        outDir: overlay,
        sources: {},
        errors: [],
        sessions: result.manifestEntries,
      }),
    );
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const script = join(
      repo,
      "src/skills/builtin/initializing-memory/scripts/prepare-history.mjs",
    );
    const output = join(root, "cohorts");
    const cli = process.env.LETTA_TEST_CLI_BUNDLE
      ? ["node", process.env.LETTA_TEST_CLI_BUNDLE]
      : [process.execPath, join(repo, "src/index.ts")];
    const child = spawnSync(
      "node",
      [
        script,
        "--export",
        overlay,
        "--out",
        output,
        "--letta",
        cli[0] ?? "bun",
        "--letta-arg",
        cli[1] ?? "src/index.ts",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    const cohorts = JSON.parse(
      await readFile(join(output, "cohorts.json"), "utf8"),
    ) as { historyCohorts: Array<{ sessions: Array<{ sessionId: string }> }> };
    expect(
      cohorts.historyCohorts.flatMap((cohort) =>
        cohort.sessions.map((session) => session.sessionId),
      ),
    ).toEqual(result.manifestEntries.map((entry) => entry.sessionId));
  });

  test("imports manifestless nested trajectory-v1 arrays and rejects symlink escapes", async () => {
    const { root, dir, backend, agent } = await fixture({
      manifest: false,
      sessions: 1,
    });
    const result = await importTrajectories(dir, agent.id, backend);
    expect(result.hasManifest).toBe(false);
    expect(result.manifestEntries[0]?.file).toBe("codex/nested/session-0.json");
    const other = await backend.createAgent({
      name: "Bad folder target",
    } as never);
    await symlink(join(root, "backend"), join(dir, "elsewhere"), "dir");
    await expect(importTrajectories(dir, other.id, backend)).rejects.toThrow(
      "Symlink",
    );
    expect(backend.listAllLocalAgentConversations(other.id)).toEqual([]);
  });

  test("a crashed staging directory is not loaded or counted as an import", async () => {
    const { root, dir, backend, agent } = await fixture({ sessions: 1 });
    const prior = await backend.createConversation({ agent_id: agent.id });
    const pending = join(
      root,
      "backend",
      "conversations",
      `${Buffer.from("conversation:local-conv-staged").toString("base64url")}.pending`,
    );
    await mkdir(pending);
    await writeFile(
      join(pending, "conversation.json"),
      JSON.stringify({
        ...prior,
        id: "local-conv-staged",
        tags: ["trajectory-import:crashed"],
      }),
    );
    const reopened = new LocalBackend({
      storageDir: join(root, "backend"),
      memfsEnabled: false,
      executionMode: "deterministic",
    });
    const conversations = (await reopened.listConversations({
      agent_id: agent.id,
    })) as unknown as Array<{ id: string }>;
    expect(
      conversations.some(
        (conversation) => conversation.id === "local-conv-staged",
      ),
    ).toBe(false);
    const result = await importTrajectories(dir, agent.id, reopened);
    expect(result.sessions).toBe(1);
  });
});
