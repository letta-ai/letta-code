import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  __testSetBackend,
  type Backend,
  type ConversationUpdateBody,
} from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { bash } from "./bash";
import { __clearExecSessionsForTests, exec_command } from "./exec-command";
import { backgroundProcesses } from "./process_manager";
import { run_shell_command } from "./run-shell-command-gemini";
import { shell } from "./shell";
import { shell_command } from "./shell-command";

class RecordingBackend {
  tags: string[] = [];
  private readonly tagWaiters = new Map<string, () => void>();

  async retrieveConversation(conversationId: string): Promise<unknown> {
    return { id: conversationId, tags: [...this.tags] };
  }

  async updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Promise<unknown> {
    const tags = Reflect.get(body, "tags");
    this.tags = Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    for (const tag of this.tags) {
      this.tagWaiters.get(tag)?.();
      this.tagWaiters.delete(tag);
    }
    return { id: conversationId, tags: [...this.tags] };
  }

  waitForTag(tag: string): Promise<void> {
    if (this.tags.includes(tag)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.tagWaiters.delete(tag);
        reject(new Error(`Timed out waiting for conversation tag ${tag}`));
      }, 10_000);
      this.tagWaiters.set(tag, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

const TEST_PR_NUMBER = 4100;
const TEST_PR_URL = `https://github.com/letta-ai/letta-code/pull/${TEST_PR_NUMBER}`;
const pathEnvKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const originalPath = process.env[pathEnvKey];
let fakeGhDir = "";

function fakeGhPrCreateCommand(): string {
  if (process.platform === "win32") {
    return "gh pr create --fill";
  }
  return `PATH=${JSON.stringify(fakeGhDir)}${delimiter}$PATH gh pr create --fill`;
}

beforeAll(() => {
  fakeGhDir = mkdtempSync(join(tmpdir(), "letta-fake-gh-"));
  const unixShim = join(fakeGhDir, "gh");
  writeFileSync(
    unixShim,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${TEST_PR_URL}\n`)});\n`,
  );
  if (process.platform !== "win32") {
    chmodSync(unixShim, 0o755);
  }
  writeFileSync(
    join(fakeGhDir, "gh.cmd"),
    `@echo off\r\necho ${TEST_PR_URL}\r\n`,
  );
  if (process.platform === "win32") {
    process.env[pathEnvKey] = `${fakeGhDir}${delimiter}${originalPath ?? ""}`;
  }
});

afterAll(() => {
  if (process.platform === "win32") {
    if (originalPath === undefined) {
      delete process.env[pathEnvKey];
    } else {
      process.env[pathEnvKey] = originalPath;
    }
  }
  rmSync(fakeGhDir, { recursive: true, force: true });
});

const adapters: Array<{
  name: string;
  run(command: string): Promise<unknown>;
}> = [
  {
    name: "foreground Bash",
    run: (command) => bash({ command, description: "Create test PR" }),
  },
  {
    name: "background Bash",
    run: (command) =>
      bash({
        command,
        description: "Create test PR",
        run_in_background: true,
      }),
  },
  {
    name: "exec_command",
    run: (cmd) => exec_command({ cmd, description: "Create test PR" }),
  },
  {
    name: "shell",
    run: (command) =>
      shell({
        command:
          process.platform === "win32"
            ? ["cmd.exe", "/d", "/s", "/c", command]
            : ["bash", "-c", command],
      }),
  },
  {
    name: "shell_command",
    run: (command) =>
      shell_command({ command, description: "Create test PR", login: false }),
  },
  {
    name: "run_shell_command",
    run: (command) =>
      run_shell_command({ command, description: "Create test PR" }),
  },
];

describe("GitHub PR tracking across shell adapters", () => {
  afterEach(() => {
    __testSetBackend(null);
    __clearExecSessionsForTests();
    for (const process of backgroundProcesses.values()) {
      try {
        process.process.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      if (process.outputFile && existsSync(process.outputFile)) {
        unlinkSync(process.outputFile);
      }
    }
    backgroundProcesses.clear();
  });

  adapters.forEach((adapter, index) => {
    test(`${adapter.name} forwards its original command`, async () => {
      const tag = `github:pull-request:letta-ai:letta-code:${TEST_PR_NUMBER}`;
      const backend = new RecordingBackend();
      __testSetBackend(backend as unknown as Backend);
      const tagObserved = backend.waitForTag(tag);

      await runWithRuntimeContext(
        {
          agentId: "agent-shell-adapters",
          conversationId: `conv-shell-adapter-${index}`,
        },
        () => adapter.run(fakeGhPrCreateCommand()),
      );
      await tagObserved;

      expect(backend.tags).toContain(tag);
    });
  });
});
