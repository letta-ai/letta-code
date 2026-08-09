import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
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
    return new Promise((resolve) => {
      this.tagWaiters.set(tag, resolve);
    });
  }
}

function fakeGhPrCreateCommand(prNumber: number): string {
  return `gh() { printf '%s\\n' 'https://github.com/letta-ai/letta-code/pull/${prNumber}'; }; gh pr create --fill`;
}

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
    run: (command) => shell({ command: ["bash", "-c", command] }),
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
      const prNumber = 4100 + index;
      const tag = `github:pull-request:letta-ai:letta-code:${prNumber}`;
      const backend = new RecordingBackend();
      __testSetBackend(backend as unknown as Backend);
      const tagObserved = backend.waitForTag(tag);

      await runWithRuntimeContext(
        {
          agentId: "agent-shell-adapters",
          conversationId: `conv-shell-adapter-${index}`,
        },
        () => adapter.run(fakeGhPrCreateCommand(prNumber)),
      );
      await tagObserved;

      expect(backend.tags).toContain(tag);
    });
  });
});
