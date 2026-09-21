import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimMemoryOperation,
  getMemoryOperationEnv,
  withMemoryOperation,
} from "@/agent/memory-operation";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { runWithRuntimeContext } from "@/runtime-context";
import { startShellProcess } from "./impl/shell-runner";
import { executeTool, getToolNames, loadSpecificTools } from "./manager";
import { runMemoryTool } from "./memory-tool-operation";

const agentId = "agent-memory-lock-test";
let root: string;
let memory: string;
let initialTools: string[];
const envKeys = [
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_LOCAL_BACKEND_DIR",
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_MEMORY_DIR_EXPLICIT",
  "LETTA_CODE_AGENT_ROLE",
] as const;
let savedEnv: Partial<NodeJS.ProcessEnv>;
const releases: Array<() => Promise<void>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-memory-operation-"));
  memory = getLocalBackendMemoryFilesystemRoot(agentId, root);
  mkdirSync(memory, { recursive: true });
  execFileSync("git", ["init", "-q", memory]);
  initialTools = getToolNames();
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_LOCAL_BACKEND_DIR: root,
    MEMORY_DIR: memory,
    LETTA_MEMORY_DIR: memory,
    LETTA_MEMORY_DIR_EXPLICIT: "1",
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await loadSpecificTools(initialTools);
  rmSync(root, { recursive: true, force: true });
});
function scope<T>(operation: () => T): T {
  return runWithRuntimeContext(
    { agentId, conversationId: "conv-primary", workingDirectory: root },
    operation,
  );
}
async function reserve() {
  const release = await claimMemoryOperation(memory);
  if (!release) throw new Error("Could not reserve checkout");
  releases.push(release);
  return release;
}

test("the production tool dispatcher waits for memory ownership while unrelated edits proceed", async () => {
  await loadSpecificTools(["Write"]);
  const release = await reserve();
  const file = join(memory, "note.md");
  const pending = scope(() =>
    executeTool("Write", { file_path: file, content: "remember this\n" }),
  );
  const unrelated = await scope(() =>
    executeTool("Write", {
      file_path: join(root, "code.ts"),
      content: "export {};\n",
    }),
  );
  expect(unrelated.status).toBe("success");
  expect(existsSync(file)).toBe(false);
  await release();
  expect((await pending).status).toBe("success");
  expect(readFileSync(file, "utf8")).toBe("remember this\n");
});

test.each([
  ["shell_command", { command: "git -C memory status", workdir: "MEMORY/.." }],
  ["Bash", { command: 'git -C "$MEMORY_DIR" status' }],
  ["shell_command", { command: "git status", workdir: "$MEMORY_DIR" }],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell variable syntax.
  ["ShellCommand", { command: 'cd "${MEMORY_DIR}" && git status' }],
  ["Shell", { command: ["git", "-C", "MEMORY", "status"] }],
  ["exec_command", { cmd: 'git -C "$MEMORY_DIR" status' }],
  [
    "ApplyPatch",
    {
      input:
        "*** Begin Patch\n*** Add File: MEMORY/new.md\n+saved\n*** End Patch",
    },
  ],
  [
    "Edit",
    { file_path: "MEMORY/note.md", old_string: "old", new_string: "new" },
  ],
  ["Memory", { command: "create", file_path: "note", file_text: "remember" }],
  ["MemoryApplyPatch", { patch: "*** Begin Patch\n*** End Patch" }],
  ["MultiEdit", { file_path: "MEMORY/note.md", edits: [] }],
] as const)("%s joins the checkout lock", async (name, input) => {
  const release = await reserve();
  const args = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((part) => (part === "MEMORY" ? memory : part))
        : typeof value === "string"
          ? value.replaceAll("MEMORY/", `${memory}/`)
          : value,
    ]),
  );
  let ran = false;
  const pending = scope(() =>
    runMemoryTool(name, args, async () => {
      ran = true;
    }),
  );
  await Bun.sleep(50);
  expect(ran).toBe(false);
  await release();
  await pending;
  expect(ran).toBe(true);
});

test("cancelling a direct memory edit leaves the worker's lock intact", async () => {
  await reserve();
  const controller = new AbortController();
  const pending = scope(() =>
    runMemoryTool(
      "Write",
      { file_path: join(memory, "note.md"), signal: controller.signal },
      async () => {
        throw new Error("Unexpected execution");
      },
    ),
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await claimMemoryOperation(memory)).toBeNull();
});

test("worker and reflection children can use their parent's lease without releasing it", async () => {
  await withMemoryOperation(memory, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withMemoryOperation } from ${JSON.stringify(join(import.meta.dir, "..", "agent", "memory-operation.ts"))}; await withMemoryOperation(process.argv[1], async () => console.log("edited"));`,
        memory,
      ],
      {
        env: { ...process.env, ...getMemoryOperationEnv() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill(), 3000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, err).toBe(0);
      expect(out.trim()).toBe("edited");
      expect(
        existsSync(join(memory, ".git", "letta-memory-operation.json")),
      ).toBe(true);
    } finally {
      clearTimeout(deadline);
    }
  });
  const release = await reserve();
  await release();
});

test.each([false, true])(
  "a yielding memory shell retains ownership until exit (cancel=%s)",
  async (cancel) => {
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let returned = false;
    const controller = new AbortController();
    const operation = scope(() =>
      runMemoryTool(
        "Bash",
        {
          command: 'cd "$MEMORY_DIR" && run-memory-script',
          signal: controller.signal,
        },
        async () => {
          startShellProcess(
            [
              process.execPath,
              "-e",
              'setTimeout(() => process.exit(0), 200); console.log("ready");',
            ],
            {
              cwd: memory,
              env: process.env,
              timeoutMs: 2000,
              onOutput: () => started(),
            },
          );
          return "yielded";
        },
      ),
    ).then((value) => {
      returned = true;
      return value;
    });
    await ready;
    expect(returned).toBe(false);
    expect(await claimMemoryOperation(memory)).toBeNull();
    if (cancel) controller.abort();
    expect(await operation).toBe("yielded");
    const release = await reserve();
    await release();
  },
);

function reflectionWorktree(): string {
  execFileSync("git", [
    "-C",
    memory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  const worktree = join(root, "reflection");
  execFileSync(
    "git",
    ["-C", memory, "worktree", "add", "-b", "reflection", worktree],
    { stdio: "pipe" },
  );
  return worktree;
}

test("a patch spanning two memory checkouts protects both", async () => {
  const worktree = reflectionWorktree();
  process.env.MEMORY_DIR = worktree;
  const result = await scope(() =>
    runMemoryTool(
      "ApplyPatch",
      {
        input: `*** Begin Patch\n*** Add File: ${memory}/first.md\n+first\n*** Add File: ${worktree}/second.md\n+second\n*** End Patch`,
        signal: AbortSignal.timeout(2000),
      },
      async () => {
        expect(await claimMemoryOperation(memory)).toBeNull();
        expect(await claimMemoryOperation(worktree)).toBeNull();
        return "edited";
      },
    ),
  );
  expect(result).toBe("edited");
});

test("isolated reflection edits proceed while a worker owns the primary checkout", async () => {
  const worktree = reflectionWorktree();
  process.env.MEMORY_DIR = worktree;
  await loadSpecificTools(["Write"]);
  await reserve();
  const file = join(worktree, "reflection.md");
  const result = await scope(() =>
    executeTool(
      "Write",
      { file_path: file, content: "reflection\n" },
      { signal: AbortSignal.timeout(2000) },
    ),
  );
  expect(result.status).toBe("success");
  expect(readFileSync(file, "utf8")).toBe("reflection\n");
  expect(await claimMemoryOperation(memory)).toBeNull();
});
