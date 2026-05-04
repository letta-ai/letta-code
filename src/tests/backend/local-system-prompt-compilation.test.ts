import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalAgentRecord } from "../../backend/local/LocalStore";
import {
  appendAvailableSkillsBlock,
  compileAvailableSkillsBlock,
  compileLocalSystemPrompt,
  hashRawSystemPrompt,
} from "../../backend/local/systemPromptCompilation";

function agent(system = "base {CORE_MEMORY}"): LocalAgentRecord {
  return {
    id: "agent-local-test",
    name: "Local Test",
    description: null,
    system,
    tags: [],
    model: "openai/gpt-test",
    model_settings: { provider_type: "openai" },
  };
}

async function writeMemoryFile(
  memoryDir: string,
  relativePath: string,
  description: string,
  body: string,
) {
  const fullPath = join(memoryDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(
    fullPath,
    `---\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
}

describe("local system prompt compilation", () => {
  test("injects MemFS system files and metadata into CORE_MEMORY", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "local-prompt-memfs-"));
    try {
      await writeMemoryFile(
        memoryDir,
        "system/persona.md",
        "Who the agent is",
        "I am a local agent.",
      );
      await writeMemoryFile(
        memoryDir,
        "system/project/gotchas.md",
        "Project gotchas",
        "Use Bun for tests.",
      );
      await writeMemoryFile(
        memoryDir,
        "reference/details.md",
        "Detailed reference",
        "Only projected as an external file.",
      );

      const compiled = compileLocalSystemPrompt({
        agent: agent("hello {CORE_MEMORY}"),
        conversationId: "local-conv-test",
        memoryDir,
        now: new Date("2026-05-04T00:00:00.000Z"),
        previousMessageCount: 7,
      });

      expect(compiled.rawSystemHash).toBe(
        hashRawSystemPrompt("hello {CORE_MEMORY}"),
      );
      expect(compiled.content).toContain("hello Reminder: <projection>");
      expect(compiled.content).toContain("<self>");
      expect(compiled.content).toContain("I am a local agent.");
      expect(compiled.content).toContain("<project>");
      expect(compiled.content).toContain(
        "<projection>$MEMORY_DIR/system/project/gotchas.md</projection>",
      );
      expect(compiled.content).toContain(
        "<description>Project gotchas</description>",
      );
      expect(compiled.content).toContain("Use Bun for tests.");
      expect(compiled.content).toContain("<external_projection>");
      expect(compiled.content).toContain("reference/");
      expect(compiled.content).toContain("details.md");
      expect(compiled.content).toContain("<memory_metadata>");
      expect(compiled.content).toContain("- AGENT_ID: agent-local-test");
      expect(compiled.content).toContain("- CONVERSATION_ID: local-conv-test");
      expect(compiled.content).toContain(
        "- System prompt last recompiled: 2026-05-04 12:00:00 AM UTC+0000",
      );
      expect(compiled.content).toContain(
        "- 7 previous messages between you and the user are stored in recall memory",
      );
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("appends memory metadata when CORE_MEMORY is missing", () => {
    const compiled = compileLocalSystemPrompt({
      agent: agent("plain base prompt"),
      conversationId: "local-conv-test",
      memoryDir: join(tmpdir(), "missing-local-memory-dir"),
      now: new Date("2026-05-04T00:00:00.000Z"),
    });

    expect(compiled.content).toStartWith("plain base prompt");
    expect(compiled.content).toContain("<memory_metadata>");
  });

  test("renders available skills as request-scoped prompt content", () => {
    const skillsBlock = compileAvailableSkillsBlock([
      {
        name: "pdf",
        description: "Read and write PDFs\nLonger details are omitted",
        location: "/repo/skills/pdf/SKILL.md",
      },
      {
        name: "linear-cli",
        description: "Manage Linear issues",
        location: "/home/user/.letta/skills/linear-cli/SKILL.md",
      },
    ]);

    expect(skillsBlock).toContain("<available_skills>");
    expect(skillsBlock).toContain("/home/user/.letta/skills");
    expect(skillsBlock).toContain(
      "└── linear-cli/\n    └── SKILL.md (Manage Linear issues)",
    );
    expect(skillsBlock).toContain("/repo/skills");
    expect(skillsBlock).toContain(
      "└── pdf/\n    └── SKILL.md (Read and write PDFs)",
    );

    expect(appendAvailableSkillsBlock("compiled", [])).toBe("compiled");
    expect(
      appendAvailableSkillsBlock("compiled", [
        {
          name: "pdf",
          description: "Read and write PDFs",
          location: "/repo/skills/pdf/SKILL.md",
        },
      ]),
    ).toContain("compiled\n\n<available_skills>");
  });
});
