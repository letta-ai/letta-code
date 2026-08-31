import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TelemetryEvent, telemetry } from "@/telemetry";
import {
  classifyExternalMemoryReads,
  trackBuiltInToolUsage,
} from "./external-memory-read-telemetry";

const tempDirectories: string[] = [];
const telemetryState = telemetry as unknown as { events: TelemetryEvent[] };
const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalLettaCodeTelem = process.env.LETTA_CODE_TELEM;

function createMemoryDir(layout: "v1" | "v2"): string {
  const agentDirectory = mkdtempSync(join(tmpdir(), "letta-memory-read-"));
  tempDirectories.push(agentDirectory);
  const memoryDir = join(agentDirectory, "memory");
  mkdirSync(memoryDir);
  if (layout === "v2")
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
  return memoryDir;
}

beforeEach(() => {
  delete process.env.DO_NOT_TRACK;
  delete process.env.LETTA_CODE_TELEM;
});

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  telemetryState.events = [];
  telemetry.setCurrentAgentId(null);
  if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = originalDoNotTrack;
  if (originalLettaCodeTelem === undefined) delete process.env.LETTA_CODE_TELEM;
  else process.env.LETTA_CODE_TELEM = originalLettaCodeTelem;
});

describe("external memory read classification", () => {
  test("classifies a MemFS v2 deferred file without logging root core memory", () => {
    const memoryDir = createMemoryDir("v2");
    mkdirSync(join(memoryDir, "reference"));
    writeFileSync(join(memoryDir, "persona.md"), "core\n");

    expect(
      classifyExternalMemoryReads({
        args: {
          file_path: "$MEMORY_DIR/reference/product.md",
          offset: 4,
          limit: 8,
        },
        memoryDir,
        toolName: "Read",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([
      {
        accessKind: "read",
        limit: 8,
        offset: 4,
        path: "reference/product.md",
        repositoryType: "agent_memory",
      },
    ]);

    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(memoryDir, "persona.md") },
        memoryDir,
        toolName: "Read",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([]);
  });

  test("classifies searches scoped to a deferred directory", () => {
    const memoryDir = createMemoryDir("v2");
    mkdirSync(join(memoryDir, "reference"));

    expect(
      classifyExternalMemoryReads({
        args: { path: join(memoryDir, "reference"), pattern: "routing" },
        memoryDir,
        toolName: "Grep",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([
      {
        accessKind: "search",
        path: "reference/**/*",
        repositoryType: "agent_memory",
      },
    ]);
  });

  test("classifies attached repositories as external memory", () => {
    const memoryDir = createMemoryDir("v2");
    const repositoryDir = join(memoryDir, "..", "team-context");
    mkdirSync(join(repositoryDir, ".git"), { recursive: true });

    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(repositoryDir, "people", "sarah.md") },
        memoryDir,
        toolName: "read_file",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([
      {
        accessKind: "read",
        path: "people/sarah.md",
        repositoryName: "team-context",
        repositoryType: "attached_repository",
      },
    ]);
  });

  test("ignores skills and paths outside memory", () => {
    const memoryDir = createMemoryDir("v2");
    mkdirSync(join(memoryDir, "skills"));

    for (const args of [
      { file_path: join(memoryDir, "skills", "linear", "SKILL.md") },
      { file_path: join(memoryDir, "..", "memory-other", "private.md") },
    ]) {
      expect(
        classifyExternalMemoryReads({
          args,
          memoryDir,
          toolName: "Read",
          workingDirectory: "/tmp/project",
        }),
      ).toEqual([]);
    }
  });

  test("uses the v1 system directory as the core-memory boundary", () => {
    const memoryDir = createMemoryDir("v1");

    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(memoryDir, "system", "human.md") },
        memoryDir,
        toolName: "ReadFile",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([]);
    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(memoryDir, "external", "research.md") },
        memoryDir,
        toolName: "ReadFile",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([
      {
        accessKind: "read",
        path: "external/research.md",
        repositoryType: "agent_memory",
      },
    ]);
  });

  test("covers every structured file-tool family", () => {
    const memoryDir = createMemoryDir("v2");
    const referenceDir = join(memoryDir, "reference");
    mkdirSync(referenceDir);

    const cases: Array<{
      accessKind: "list" | "read" | "search";
      args: Record<string, unknown>;
      names: string[];
    }> = [
      {
        accessKind: "read",
        args: { file_path: join(referenceDir, "models.md") },
        names: [
          "Read",
          "ReadFile",
          "ReadFileGemini",
          "ReadLSP",
          "read_file",
          "read_file_gemini",
        ],
      },
      {
        accessKind: "read",
        args: { path: join(referenceDir, "diagram.png") },
        names: ["view_image", "ViewImage"],
      },
      {
        accessKind: "search",
        args: { path: referenceDir, pattern: "models" },
        names: ["Grep", "GrepFiles", "grep_files"],
      },
      {
        accessKind: "search",
        args: { dir_path: referenceDir, pattern: "models" },
        names: ["SearchFileContent", "search_file_content"],
      },
      {
        accessKind: "list",
        args: { path: referenceDir, pattern: "*.md" },
        names: ["Glob", "LS"],
      },
      {
        accessKind: "list",
        args: { dir_path: referenceDir, pattern: "*.md" },
        names: [
          "GlobGemini",
          "ListDir",
          "ListDirectory",
          "glob_gemini",
          "list_dir",
          "list_directory",
        ],
      },
    ];

    for (const entry of cases) {
      for (const toolName of entry.names) {
        expect(
          classifyExternalMemoryReads({
            args: entry.args,
            memoryDir,
            toolName,
            workingDirectory: "/tmp/project",
          }),
        ).toEqual([
          expect.objectContaining({
            accessKind: entry.accessKind,
            repositoryType: "agent_memory",
          }),
        ]);
      }
    }

    for (const toolName of ["ReadManyFiles", "read_many_files"]) {
      expect(
        classifyExternalMemoryReads({
          args: { include: [join(referenceDir, "**", "*.md")] },
          memoryDir,
          toolName,
          workingDirectory: "/tmp/project",
        }),
      ).toEqual([
        expect.objectContaining({
          accessKind: "read",
          path: "reference/**/*.md",
        }),
      ]);
    }
  });

  test("emits a scoped event after tool completion without absolute paths", () => {
    const memoryDir = createMemoryDir("v2");
    mkdirSync(join(memoryDir, "reference"));
    telemetry.setCurrentAgentId("agent-process-global");

    trackBuiltInToolUsage({
      agentId: "agent-scoped",
      args: { file_path: join(memoryDir, "reference", "models.md") },
      conversationId: "conv-scoped",
      durationMs: 12,
      memoryDir,
      responseLength: 480,
      success: true,
      toolCallId: "toolu-read",
      toolName: "Read",
      workingDirectory: "/tmp/project",
    });

    expect(telemetryState.events).toHaveLength(2);
    expect(telemetryState.events[1]).toEqual(
      expect.objectContaining({
        type: "external_memory_read",
        data: expect.objectContaining({
          agent_id: "agent-scoped",
          conversation_id: "conv-scoped",
          duration_ms: 12,
          success: true,
          target_count: 1,
          targets: [
            {
              path: "reference/models.md",
              repository_name: undefined,
              repository_type: "agent_memory",
            },
          ],
          targets_truncated: false,
          tool_call_id: "toolu-read",
        }),
      }),
    );
    expect(telemetryState.events[1]?.data.agent_origin).toBeUndefined();
    expect(JSON.stringify(telemetryState.events[1])).not.toContain(memoryDir);
  });

  test("uses a glob pattern below the memory root as the external target", () => {
    const memoryDir = createMemoryDir("v2");
    mkdirSync(join(memoryDir, "reference"));

    expect(
      classifyExternalMemoryReads({
        args: { path: memoryDir, pattern: "reference/**/*.md" },
        memoryDir,
        toolName: "Glob",
        workingDirectory: "/tmp/project",
      }),
    ).toEqual([
      {
        accessKind: "list",
        path: "reference/**/*.md",
        repositoryType: "agent_memory",
      },
    ]);
  });

  test("classifies canonical read targets across symlink boundaries", () => {
    const memoryDir = createMemoryDir("v2");
    const referenceDir = join(memoryDir, "reference");
    const projectDir = mkdtempSync(join(tmpdir(), "letta-project-"));
    tempDirectories.push(projectDir);
    mkdirSync(referenceDir);
    symlinkSync(referenceDir, join(projectDir, "memory-link"));
    symlinkSync(projectDir, join(referenceDir, "outside-link"));

    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(projectDir, "memory-link", "product.md") },
        memoryDir,
        toolName: "Read",
        workingDirectory: projectDir,
      }),
    ).toEqual([
      {
        accessKind: "read",
        path: "reference/product.md",
        repositoryType: "agent_memory",
      },
    ]);
    expect(
      classifyExternalMemoryReads({
        args: { file_path: join(referenceDir, "outside-link", "private.md") },
        memoryDir,
        toolName: "Read",
        workingDirectory: projectDir,
      }),
    ).toEqual([]);
  });

  test("coalesces bulk reads into one bounded telemetry event", () => {
    const memoryDir = createMemoryDir("v2");
    const referenceDir = join(memoryDir, "reference");
    mkdirSync(referenceDir);

    trackBuiltInToolUsage({
      args: {
        include: Array.from({ length: 25 }, (_, index) =>
          join(referenceDir, `file-${index}.md`),
        ),
      },
      durationMs: 20,
      memoryDir,
      responseLength: 900,
      success: true,
      toolName: "ReadManyFiles",
      workingDirectory: "/tmp/project",
    });

    expect(telemetryState.events).toHaveLength(2);
    const eventData = telemetryState.events[1]?.data;
    expect(eventData).toEqual(
      expect.objectContaining({
        target_count: 25,
        targets_truncated: true,
      }),
    );
    expect(eventData?.targets).toHaveLength(20);
  });
});
