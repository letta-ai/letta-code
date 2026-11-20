import { afterAll, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";

const realRootsModule = { ...(await import("@/utils/cloud-repository-roots")) };
afterAll(() => {
  mock.restore();
  mock.module("@/utils/cloud-repository-roots", () => realRootsModule);
});

test("a late cloud checkout sends one skill update on the next turn", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "letta-cloud-skills-"));
  const repo = join(scratch, "repo");
  mock.module("@/utils/cloud-repository-roots", () => ({
    ...realRootsModule,
    cloudRepositoryRoots: (names?: readonly string[]) =>
      names?.length ? [repo] : [],
  }));
  const { sendMessageStreamWithBackend } = await import("./message");
  const requests: MessageCreateParams[] = [];
  const backend = {
    createConversationMessageStream: async (
      _conversationId: string,
      body: MessageCreateParams,
    ) => {
      requests.push(body);
      return { async *[Symbol.asyncIterator]() {} };
    },
  } as unknown as Backend;

  try {
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {
        runtimeContext: {
          workingDirectory: scratch,
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            cloud_skill_repositories: ["repo"],
          },
        },
      });
    const conversationId = `conv-${crypto.randomUUID()}`;
    const sendTurn = () =>
      sendMessageStreamWithBackend(
        backend,
        conversationId,
        [{ type: "message", role: "user", content: "Hello" }],
        { skillSources: ["project"], preparedToolContext },
      );
    await sendTurn();
    const skill = join(repo, ".agents", "skills", "late-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: late-skill\ndescription: Late repository skill\n---\nSkill body\n",
    );
    await sendTurn();
    await sendTurn();

    expect(requests.map(({ messages }) => messages?.length)).toEqual([1, 2, 1]);
    expect(JSON.stringify(requests[1]?.messages?.[1])).toContain(
      "Late repository skill",
    );
    expect(requests.map(({ client_skills }) => client_skills)).toEqual([
      [],
      [],
      [],
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
