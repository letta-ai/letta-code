import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { invalidateClientSkillsPayloadCache } from "./client-skills";
import { sendMessageStreamWithBackend } from "./message";

afterEach(() => invalidateClientSkillsPayloadCache());

describe("sendMessageStream skill sources", () => {
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
    const skillsDirectory = await mkdtemp(
      join(tmpdir(), "letta-listener-skills-"),
    );
    const skillDirectory = join(skillsDirectory, "searching-and-viewing-slack");
    await mkdir(skillDirectory);
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
          runtimeContext: { skillsDirectory },
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
      await rm(skillsDirectory, { recursive: true, force: true });
    }
  });
});
