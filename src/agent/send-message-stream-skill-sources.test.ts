import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import {
  buildClientSkillsUpdateReminder,
  invalidateClientSkillsPayloadCache,
} from "./client-skills";
import {
  buildConversationMessagesCreateRequestBody,
  sendMessageStreamWithBackend,
} from "./message";

afterEach(() => invalidateClientSkillsPayloadCache());

describe("sendMessageStream skill sources", () => {
  test("browser-control skill disables curlrc before every other curl option", () => {
    const body = readFileSync(
      join(
        import.meta.dir,
        "../skills/builtin/browser-control-over-wire/SKILL.md",
      ),
      "utf8",
    );
    const curlInvocation = body.match(/curl[^\n]+/)?.[0];

    expect(curlInvocation).toBe("curl -q --silent --show-error \\");
  });

  test("forwards a request-scoped response format to the Messages API", () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "response_schema",
        schema: { type: "object" },
        strict: true,
      },
    };
    const body = buildConversationMessagesCreateRequestBody(
      "conv-structured",
      [{ type: "message", role: "user", content: "Return JSON" }],
      { responseFormat },
      [],
    );
    expect(body.response_format).toEqual(responseFormat);
  });

  test("reports metadata deltas, not bodies, order changes, or the initial catalog", () => {
    const skill = {
      name: "search",
      description: "Search",
      location: "/search/SKILL.md",
    };
    const other = {
      name: "review",
      description: "Review",
      location: "/review/SKILL.md",
    };
    expect(buildClientSkillsUpdateReminder(undefined, [skill])).toBeNull();
    expect(
      buildClientSkillsUpdateReminder([skill, other], [other, skill]),
    ).toBeNull();
    const reminder = buildClientSkillsUpdateReminder([skill], [other]);
    expect(reminder).toContain(
      "Additional skills are now available. These supplement the skills already listed in your context:\n<available_skills>\n  <skill>\n    <name>review</name>\n    <description>Review</description>\n  </skill>\n</available_skills>",
    );
    expect(reminder).not.toContain(other.location);
    expect(reminder).toContain("Skills no longer available:\n- search");
    expect(
      buildClientSkillsUpdateReminder(
        [],
        [{ ...skill, name: "a&b", description: "<example>" }],
      ),
    ).toContain(
      "<name>a&amp;b</name>\n    <description>&lt;example&gt;</description>",
    );
    expect(
      buildClientSkillsUpdateReminder(
        [skill],
        [{ ...skill, description: "New description" }],
      ),
    ).toContain("New description");
    expect(
      buildClientSkillsUpdateReminder(
        [skill],
        [{ ...skill, location: "/moved/SKILL.md" }],
      ),
    ).toContain("<name>search</name>");
  });

  test("notifies each conversation once, preserves approvals, and retries rejected sends", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-skill-notifications-"));
    const skillsDirectory = join(root, "skills");
    await mkdir(skillsDirectory);
    const recorded: Array<{
      conversationId: string;
      body: MessageCreateParams;
      headers?: Record<string, string>;
    }> = [];
    let rejectNext = false;
    // Capture the backend boundary; skill discovery and file parsing are real.
    const backend = {
      createConversationMessageStream: async (
        conversationId: string,
        body: MessageCreateParams,
        requestOptions?: { headers?: Record<string, string> },
      ) => {
        recorded.push({
          conversationId,
          body,
          headers: requestOptions?.headers,
        });
        if (rejectNext) {
          rejectNext = false;
          throw new Error("request rejected");
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              message_type: "response_state",
              cache_scope: "approval_boundary",
              response_id: "skill-response-state",
            };
          },
        };
      },
    } as unknown as Backend;
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {
        runtimeContext: { skillsDirectory, workingDirectory: root },
      });
    const options = { skillSources: ["project" as const], preparedToolContext };
    const input = [
      {
        type: "message" as const,
        role: "user" as const,
        content: "hello",
        otid: "original-input",
      },
    ];
    const send = async (conversationId: string) => {
      const stream = await sendMessageStreamWithBackend(
        backend,
        conversationId,
        input,
        options,
      );
      for await (const _chunk of stream) {
        /* consume response-state metadata */
      }
    };
    try {
      await send("conv-a");
      await send("conv-b");
      await sendMessageStreamWithBackend(backend, "conv-c", input, {
        ...options,
        agentId: "agent-local-a",
      });
      const skillDir = join(skillsDirectory, "late-skill");
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: late-skill\ndescription: Newly cloned skill\n---\nBODY_MUST_STAY_LAZY",
      );
      invalidateClientSkillsPayloadCache();
      rejectNext = true;
      await expect(send("conv-a")).rejects.toThrow("request rejected");
      await send("conv-a");
      const accepted = recorded.at(-1)?.body;
      expect(accepted?.messages?.[0]).toEqual(input[0]);
      const content = accepted?.messages?.[1];
      if (content?.type !== "message")
        throw new Error("Expected skill reminder");
      expect(content.role).toBe("user");
      expect(content.content).toContain("<system-reminder>");
      expect(content.content).toContain("Newly cloned skill");
      expect(JSON.stringify(content)).not.toContain("BODY_MUST_STAY_LAZY");
      expect(accepted?.client_skills).toEqual([
        {
          name: "late-skill",
          description: "Newly cloned skill",
          location: join(skillDir, "SKILL.md"),
        },
      ]);
      expect(recorded.at(-2)?.body.messages).toEqual(accepted?.messages);
      await send("conv-a");
      expect(recorded.at(-1)?.body.messages).toHaveLength(1);
      const approvals = [
        {
          type: "approval" as const,
          approvals: [
            {
              type: "tool" as const,
              tool_call_id: "call-1",
              status: "success" as const,
              tool_return: "done",
            },
          ],
        },
      ];
      await sendMessageStreamWithBackend(backend, "conv-b", approvals, {
        ...options,
        allowResponseStateReuse: true,
      });
      expect(recorded.at(-1)?.body.messages?.[0]?.type).toBe("approval");
      expect(recorded.at(-1)?.body.messages).toHaveLength(2);
      expect(
        recorded.at(-1)?.headers?.["X-Letta-Response-State"],
      ).toBeUndefined();
      await sendMessageStreamWithBackend(backend, "conv-a", approvals, {
        ...options,
        allowResponseStateReuse: true,
      });
      expect(
        recorded.at(-1)?.headers?.["X-Letta-Response-State"],
      ).toBeDefined();
      await send("conv-c");
      expect(recorded.at(-1)?.body.messages).toHaveLength(2);
      await send("conv-new");
      expect(recorded.at(-1)?.body.messages).toHaveLength(1);
      expect(input).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("forwards transient skills without adding them to messages or installed-skill state", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-request-skills-"));
    const skillsDirectory = join(root, "skills");
    const installedSkillDirectory = join(skillsDirectory, "installed-skill");
    await mkdir(installedSkillDirectory, { recursive: true });
    await writeFile(
      join(installedSkillDirectory, "SKILL.md"),
      [
        "---",
        "name: installed-skill",
        "description: A normal installed skill.",
        "---",
      ].join("\n"),
    );

    const recorded: MessageCreateParams[] = [];
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: MessageCreateParams,
      ) => {
        recorded.push(body);
        return {
          async *[Symbol.asyncIterator]() {},
        } as unknown as Stream<LettaStreamingResponse>;
      },
    } as unknown as Backend;
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {
        runtimeContext: { skillsDirectory, workingDirectory: root },
      });
    const secret = "ephemeral-key-123";
    const input = [
      { role: "user" as const, content: "Use the temporary skill." },
    ];

    try {
      await sendMessageStreamWithBackend(
        backend,
        "conv-request-skills",
        input,
        {
          skillSources: ["project"],
          preparedToolContext,
          requestScopedClientSkills: [
            {
              name: "temporary-skill",
              description: `Pair with ${secret}`,
              location: "/temporary/SKILL.md",
            },
            {
              name: "temporary-skill",
              description: `Use the final ${secret}`,
              location: "/temporary/final/SKILL.md",
            },
          ],
        },
      );

      expect(recorded[0]?.client_skills).toEqual([
        {
          name: "installed-skill",
          description: "A normal installed skill.",
          location: join(installedSkillDirectory, "SKILL.md"),
        },
        {
          name: "temporary-skill",
          description: `Use the final ${secret}`,
          location: "/temporary/final/SKILL.md",
        },
      ]);
      expect(recorded[0]?.messages).toEqual(input);
      expect(JSON.stringify(recorded[0]?.messages)).not.toContain(secret);

      const continuation = [
        {
          type: "approval" as const,
          approvals: [
            {
              type: "tool" as const,
              tool_call_id: "call-1",
              status: "success" as const,
              tool_return: "done",
            },
          ],
        },
      ];
      await sendMessageStreamWithBackend(
        backend,
        "conv-request-skills",
        continuation,
        {
          skillSources: ["project"],
          preparedToolContext,
          requestScopedClientSkills: recorded[0]?.client_skills?.filter(
            (skill) => skill.name === "temporary-skill",
          ),
        },
      );
      expect(recorded[1]?.client_skills).toContainEqual(
        expect.objectContaining({ name: "temporary-skill" }),
      );
      expect(JSON.stringify(recorded[1]?.messages)).not.toContain(secret);

      await sendMessageStreamWithBackend(
        backend,
        "conv-request-skills",
        input,
        { skillSources: ["project"], preparedToolContext },
      );

      expect(recorded[2]?.client_skills).toEqual([
        {
          name: "installed-skill",
          description: "A normal installed skill.",
          location: join(installedSkillDirectory, "SKILL.md"),
        },
      ]);
      expect(recorded[2]?.messages).toEqual(input);
      expect(JSON.stringify(recorded[2])).not.toContain(secret);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sends no client skills when the runtime override is empty", async () => {
    let recordedBody: MessageCreateParams | undefined;
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: MessageCreateParams,
      ) => {
        recordedBody = body;
        return stream;
      },
    } as unknown as Backend;

    await sendMessageStreamWithBackend(
      backend,
      "conv-no-skills",
      [{ role: "user", content: "Reflect on this trajectory." }],
      {
        streamTokens: true,
        background: true,
        skillSources: [],
        preparedToolContext: {
          contextId: "ctx-no-skills",
          clientTools: [],
          loadedToolNames: [],
        },
      },
    );

    expect(recordedBody?.client_skills).toEqual([]);
  });

  test("sends skills from the listener environment directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "letta-listener-skills-"));
    const skillsDirectory = join(tempRoot, "environment-skills");
    const workingDirectory = join(tempRoot, "workspace");
    const skillDirectory = join(skillsDirectory, "searching-and-viewing-slack");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(workingDirectory);
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: searching-and-viewing-slack",
        "description: Search Slack from a managed computer.",
        "---",
        "",
        "Use agent-slack.",
      ].join("\n"),
    );

    try {
      let recordedBody: MessageCreateParams | undefined;
      const stream = {
        async *[Symbol.asyncIterator]() {},
      } as unknown as Stream<LettaStreamingResponse>;
      const backend = {
        createConversationMessageStream: async (
          _conversationId: string,
          body: MessageCreateParams,
        ) => {
          recordedBody = body;
          return stream;
        },
      } as unknown as Backend;
      const preparedToolContext =
        await prepareToolExecutionContextForSpecificTools([], {
          runtimeContext: { skillsDirectory, workingDirectory },
        });

      await sendMessageStreamWithBackend(
        backend,
        "conv-managed-skills",
        [{ role: "user", content: "Search Slack." }],
        {
          streamTokens: true,
          background: true,
          skillSources: ["project"],
          preparedToolContext,
        },
      );

      expect(recordedBody?.client_skills).toEqual([
        {
          name: "searching-and-viewing-slack",
          description: "Search Slack from a managed computer.",
          location: join(skillDirectory, "SKILL.md"),
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
