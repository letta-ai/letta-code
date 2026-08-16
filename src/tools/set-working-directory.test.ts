import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { set_working_directory } from "@/tools/impl/set-working-directory";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearToolsWithLock,
  executeTool,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  loadSpecificTools,
  OPENAI_PASCAL_TOOLS,
  prepareCurrentToolExecutionContext,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import { createRuntime } from "@/websocket/listener/lifecycle";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import { stopAllWorktreeWatchers } from "@/websocket/listener/worktree-watcher";

const tempRoots: string[] = [];
const originalUserCwd = process.env.USER_CWD;

afterEach(async () => {
  clearToolsWithLock();
  const runtime = getActiveRuntime();
  if (runtime) {
    stopAllWorktreeWatchers(runtime);
  }
  setActiveRuntime(null);
  if (originalUserCwd === undefined) {
    delete process.env.USER_CWD;
  } else {
    process.env.USER_CWD = originalUserCwd;
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createDirectoryTree(): Promise<{
  root: string;
  target: string;
}> {
  const createdRoot = await mkdtemp(joinTemp("letta-set-cwd-"));
  tempRoots.push(createdRoot);
  const root = await realpath(createdRoot);
  const target = path.join(root, "nested");
  await mkdir(target, { recursive: true });
  return { root, target: await realpath(target) };
}

function joinTemp(prefix: string): string {
  return path.join(tmpdir(), prefix);
}

function toolReturnText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(value);
}

test("is available in the model-facing toolsets", () => {
  expect(ANTHROPIC_DEFAULT_TOOLS).toContain("SetWorkingDirectory");
  expect(GEMINI_DEFAULT_TOOLS).toContain("SetWorkingDirectory");
  expect(GEMINI_PASCAL_TOOLS).toContain("SetWorkingDirectory");
  expect(OPENAI_PASCAL_TOOLS).toContain("SetWorkingDirectory");
});

test("changes the conversation cwd and resolves relative paths", async () => {
  const { root, target } = await createDirectoryTree();
  const listener = createRuntime();
  listener.bootWorkingDirectory = root;
  setActiveRuntime(listener);

  const result = await runWithRuntimeContext(
    {
      agentId: "agent-1",
      conversationId: "conversation-1",
      workingDirectory: root,
    },
    () => set_working_directory({ path: "nested" }),
  );

  expect(result.status).toBe("success");
  expect(result.working_directory).toBe(target);
  expect(
    getConversationWorkingDirectory(listener, "agent-1", "conversation-1"),
  ).toBe(target);
  stopAllWorktreeWatchers(listener);
});

test("updates the active tool context for later calls in the same turn", async () => {
  const { root, target } = await createDirectoryTree();
  const listener = createRuntime();
  listener.bootWorkingDirectory = root;
  setActiveRuntime(listener);
  await loadSpecificTools(["SetWorkingDirectory", "Bash"]);
  const scope = {
    agentId: "agent-1",
    conversationId: "conversation-1",
    workingDirectory: root,
  };
  const prepared = await runWithRuntimeContext(scope, () =>
    prepareCurrentToolExecutionContext({ workingDirectory: root }),
  );

  try {
    const changeResult = await runWithRuntimeContext(scope, () =>
      executeTool(
        "SetWorkingDirectory",
        { path: "nested" },
        { toolContextId: prepared.contextId },
      ),
    );
    expect(changeResult.status).toBe("success");

    const pwdResult = await executeTool(
      "Bash",
      { command: 'node -e "console.log(process.cwd())"' },
      { toolContextId: prepared.contextId },
    );
    expect(pwdResult.status).toBe("success");
    expect(toolReturnText(pwdResult.toolReturn).trim()).toBe(target);
  } finally {
    releaseToolExecutionContext(prepared.contextId);
  }
});

test("rejects files and leaves the conversation cwd unchanged", async () => {
  const { root } = await createDirectoryTree();
  const filePath = path.join(root, "file.txt");
  await writeFile(filePath, "not a directory");
  const listener = createRuntime();
  listener.bootWorkingDirectory = root;
  setActiveRuntime(listener);

  const result = await runWithRuntimeContext(
    {
      agentId: "agent-1",
      conversationId: "conversation-1",
      workingDirectory: root,
    },
    () => set_working_directory({ path: filePath }),
  );

  expect(result.status).toBe("error");
  expect(result.content[0]?.text).toContain("Not a directory");
  expect(
    getConversationWorkingDirectory(listener, "agent-1", "conversation-1"),
  ).toBe(root);
  stopAllWorktreeWatchers(listener);
});

test("requires a non-empty path", async () => {
  const result = await set_working_directory({ path: "   " });

  expect(result).toEqual({
    content: [{ type: "text", text: "Provide a directory path." }],
    status: "error",
  });
});
