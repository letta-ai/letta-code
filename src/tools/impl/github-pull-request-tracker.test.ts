import { describe, expect, test } from "bun:test";
import type { ConversationUpdateBody } from "@/backend";
import {
  type ConversationTagBackend,
  copyGitHubPullRequestTags,
  createGitHubPullRequestOutputTracker,
  isGitHubPullRequestCreateCommand,
} from "./github-pull-request-tracker";

class FakeConversationTagBackend implements ConversationTagBackend {
  tags: string[];
  updates: string[][] = [];
  updateError?: Error;

  constructor(tags: string[] = []) {
    this.tags = tags;
  }

  async retrieveConversation(_conversationId: string): Promise<unknown> {
    return { id: _conversationId, tags: [...this.tags] };
  }

  async updateConversation(
    _conversationId: string,
    body: ConversationUpdateBody,
  ): Promise<unknown> {
    if (this.updateError) {
      throw this.updateError;
    }
    const tags = Reflect.get(body, "tags");
    this.tags = Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    this.updates.push([...this.tags]);
    return { id: _conversationId, tags: [...this.tags] };
  }
}

class MultiConversationTagBackend implements ConversationTagBackend {
  readonly tagsByConversation = new Map<string, string[]>();

  constructor(conversations: Record<string, string[]>) {
    for (const [conversationId, tags] of Object.entries(conversations)) {
      this.tagsByConversation.set(conversationId, [...tags]);
    }
  }

  async retrieveConversation(conversationId: string): Promise<unknown> {
    return {
      id: conversationId,
      tags: [...(this.tagsByConversation.get(conversationId) ?? [])],
    };
  }

  async updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Promise<unknown> {
    const tags = Reflect.get(body, "tags");
    const nextTags = Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    this.tagsByConversation.set(conversationId, nextTags);
    return { id: conversationId, tags: [...nextTags] };
  }
}

describe("GitHub pull request command detection", () => {
  const creatingCommands: Array<string | string[]> = [
    "gh pr create --title fix --body body",
    "cd /repo && gh pr create --draft --fill",
    'GH_TOKEN="$TOKEN" gh pr create -R letta-ai/letta-code --fill',
    "env GH_TOKEN=value /usr/bin/gh --repo letta-ai/letta-code pr create --fill",
    "command gh pr create --fill",
    ["gh", "pr", "create", "--fill"],
    ["bash", "-lc", "git push && gh pr create --fill"],
    ["env", "GH_TOKEN=value", "pwsh", "-Command", "gh pr create --fill"],
  ];

  for (const command of creatingCommands) {
    test(`recognizes ${JSON.stringify(command)}`, () => {
      expect(isGitHubPullRequestCreateCommand(command)).toBe(true);
    });
  }

  test("recognizes create after writing a PR body with a heredoc", () => {
    const command = [
      'body="/tmp/pr-body.md"',
      "cat > \"$body\" <<'EOF'",
      "## Summary",
      "- `bun run check` passes",
      "EOF",
      'gh pr create --draft --title "Fix" --body-file "$body"',
      'rm -f "$body"',
    ].join("\n");

    expect(isGitHubPullRequestCreateCommand(command)).toBe(true);
  });

  const otherCommands: Array<string | string[]> = [
    "gh pr view 3744",
    "echo gh pr create",
    'echo "gh pr create"',
    "gh pr create --dry-run --fill",
    "gh pr create --web",
    "gh pr create -w",
    ["bash", "-lc", "gh pr view 3744"],
  ];

  for (const command of otherCommands) {
    test(`ignores ${JSON.stringify(command)}`, () => {
      expect(isGitHubPullRequestCreateCommand(command)).toBe(false);
    });
  }

  test("ignores gh commands written inside a heredoc body", () => {
    const command = [
      "cat > /tmp/example.md <<'EOF'",
      "gh pr create --fill",
      "EOF",
    ].join("\n");

    expect(isGitHubPullRequestCreateCommand(command)).toBe(false);
  });
});

describe("GitHub pull request output tracking", () => {
  test("preserves existing tags and handles a URL split across chunks", async () => {
    const backend = new FakeConversationTagBackend([
      "channel:slack",
      "origin:schedule",
    ]);
    const tracker = createGitHubPullRequestOutputTracker(
      "gh pr create --fill",
      { conversationId: "conv-1", backend },
    );

    expect(tracker).toBeDefined();
    tracker?.append("\u001b[32mhttps://github.com/Letta-AI/Letta-", "stdout");
    tracker?.append("Code/pull/3744\u001b[0m\n", "stdout");
    await tracker?.finish();

    expect(backend.tags).toEqual([
      "channel:slack",
      "origin:schedule",
      "github:pull-request:letta-ai:letta-code:3744",
    ]);
    expect(backend.updates).toHaveLength(1);
  });

  test("tracks each distinct standalone PR URL", async () => {
    const backend = new FakeConversationTagBackend();
    const tracker = createGitHubPullRequestOutputTracker(
      "git push && gh pr create --fill",
      { conversationId: "conv-2", backend },
    );

    tracker?.append(
      [
        "Created: https://github.com/letta-ai/other/pull/1",
        "https://github.com/letta-ai/letta-code/pull/3744",
        "https://github.com/letta-ai/letta-code/pull/3744",
        "https://github.com/letta-ai/letta-code/pull/3745",
        "",
      ].join("\n"),
      "stdout",
    );
    await tracker?.finish();

    expect(backend.tags).toEqual([
      "github:pull-request:letta-ai:letta-code:3744",
      "github:pull-request:letta-ai:letta-code:3745",
    ]);
  });

  test("records the PR URL returned when gh reports an existing PR", async () => {
    const backend = new FakeConversationTagBackend();
    const tracker = createGitHubPullRequestOutputTracker(
      "gh pr create --fill",
      { conversationId: "conv-3", backend },
    );

    tracker?.append(
      'a pull request for branch "feature" already exists:\n',
      "stderr",
    );
    tracker?.append(
      "https://github.com/letta-ai/letta-code/pull/3744\n",
      "stderr",
    );
    await tracker?.finish();

    expect(backend.tags).toEqual([
      "github:pull-request:letta-ai:letta-code:3744",
    ]);
  });

  test("serializes updates for the same conversation", async () => {
    const backend = new FakeConversationTagBackend(["channel:discord"]);
    const first = createGitHubPullRequestOutputTracker("gh pr create --fill", {
      conversationId: "conv-4",
      backend,
    });
    const second = createGitHubPullRequestOutputTracker("gh pr create --fill", {
      conversationId: "conv-4",
      backend,
    });

    first?.append(
      "https://github.com/letta-ai/letta-code/pull/3744\n",
      "stdout",
    );
    second?.append(
      "https://github.com/letta-ai/letta-code/pull/3745\n",
      "stdout",
    );
    await Promise.all([first?.finish(), second?.finish()]);

    expect(backend.tags).toEqual([
      "channel:discord",
      "github:pull-request:letta-ai:letta-code:3744",
      "github:pull-request:letta-ai:letta-code:3745",
    ]);
  });

  test("skips default conversations and commands without PR creation", () => {
    const backend = new FakeConversationTagBackend();

    expect(
      createGitHubPullRequestOutputTracker("gh pr create --fill", {
        conversationId: "default",
        backend,
      }),
    ).toBeUndefined();
    expect(
      createGitHubPullRequestOutputTracker("gh pr view 3744", {
        conversationId: "conv-5",
        backend,
      }),
    ).toBeUndefined();
  });

  test("does not change shell behavior when the metadata update fails", async () => {
    const backend = new FakeConversationTagBackend();
    backend.updateError = new Error("metadata unavailable");
    const tracker = createGitHubPullRequestOutputTracker(
      "gh pr create --fill",
      { conversationId: "conv-6", backend },
    );

    tracker?.append(
      "https://github.com/letta-ai/letta-code/pull/3744\n",
      "stdout",
    );

    await expect(tracker?.finish()).resolves.toBeUndefined();
  });
});

describe("GitHub pull request tag copying", () => {
  test("copies only PR tags from an Agent conversation to its parent", async () => {
    const backend = new MultiConversationTagBackend({
      "conv-child": [
        "origin:subagent",
        "github:pull-request:letta-ai:letta-code:3851",
        "github:pull-request:letta-ai:letta-code:3853",
      ],
      "conv-parent": [
        "channel:slack",
        "github:pull-request:letta-ai:letta-code:3852",
      ],
    });

    await copyGitHubPullRequestTags("conv-child", "conv-parent", backend);

    expect(backend.tagsByConversation.get("conv-parent")).toEqual([
      "channel:slack",
      "github:pull-request:letta-ai:letta-code:3852",
      "github:pull-request:letta-ai:letta-code:3851",
      "github:pull-request:letta-ai:letta-code:3853",
    ]);
  });

  test("serializes PR tags copied from parallel Agent conversations", async () => {
    const backend = new MultiConversationTagBackend({
      "conv-child-a": ["github:pull-request:letta-ai:letta-code:3851"],
      "conv-child-b": ["github:pull-request:letta-ai:letta-code:3852"],
      "conv-parent": [],
    });

    await Promise.all([
      copyGitHubPullRequestTags("conv-child-a", "conv-parent", backend),
      copyGitHubPullRequestTags("conv-child-b", "conv-parent", backend),
    ]);

    expect(backend.tagsByConversation.get("conv-parent")).toEqual([
      "github:pull-request:letta-ai:letta-code:3851",
      "github:pull-request:letta-ai:letta-code:3852",
    ]);
  });

  test("stops an in-flight tag copy when its Agent turn is interrupted", async () => {
    const abortController = new AbortController();
    let targetReadStarted = false;
    let updateCalled = false;
    const backend: ConversationTagBackend = {
      retrieveConversation: async (conversationId, options) => {
        expect(options?.signal).toBe(abortController.signal);
        if (conversationId === "conv-child") {
          return {
            tags: ["github:pull-request:letta-ai:letta-code:3995"],
          };
        }
        targetReadStarted = true;
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
      updateConversation: async () => {
        updateCalled = true;
        return {};
      },
    };

    const copy = copyGitHubPullRequestTags(
      "conv-child",
      "conv-parent",
      backend,
      abortController.signal,
    );
    await Bun.sleep(0);
    expect(targetReadStarted).toBe(true);
    abortController.abort();

    await expect(copy).rejects.toMatchObject({ name: "AbortError" });
    expect(updateCalled).toBe(false);
  });
});
