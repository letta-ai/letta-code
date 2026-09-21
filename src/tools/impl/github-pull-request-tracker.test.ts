import { describe, expect, test } from "bun:test";
import type { ConversationUpdateBody } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  type ConversationTagBackend,
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
    expect(body).not.toHaveProperty("tags");
    const tags = body.tags_to_add;
    this.tags = Array.isArray(tags)
      ? [...new Set([...this.tags, ...tags])]
      : this.tags;
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
    expect(body).not.toHaveProperty("tags");
    const tags = body.tags_to_add;
    const nextTags = Array.isArray(tags)
      ? [
          ...new Set([
            ...(this.tagsByConversation.get(conversationId) ?? []),
            ...tags,
          ]),
        ]
      : (this.tagsByConversation.get(conversationId) ?? []);
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
    "timeout 45 gh pr create -R letta-ai/letta-cloud --fill; git rev-parse HEAD",
    "timeout 90 git push -u origin HEAD && timeout -k 5 45 gh pr create --fill",
    ["gh", "pr", "create", "--fill"],
    ["timeout", "--signal=TERM", "45", "gh", "pr", "create", "--fill"],
    ["bash", "-lc", "git push && gh pr create --fill"],
    ["timeout", "45", "bash", "-lc", "git push && gh pr create --fill"],
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
    "timeout 45 echo gh pr create --fill",
    "timeout --help gh pr create --fill",
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

  test("adds tags without replacement for concurrent updates to the same conversation", async () => {
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

  test.each(["success", "rejection"] as const)(
    "allows the next PR while a cancelled update ends in late %s",
    async (lateResult) => {
      const started = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<void>();
      const controller = new AbortController();
      let first = true;
      let tags: string[] = [];
      const backend: ConversationTagBackend = {
        updateConversation: async (id, body) => {
          expect(body).not.toHaveProperty("tags");
          if (first) {
            first = false;
            started.resolve();
            await stalled.promise;
          }
          tags = [...new Set([...tags, ...(body.tags_to_add ?? [])])];
          return { id, tags };
        },
      };
      const options = {
        conversationId: `conv-cancel-${lateResult}`,
        attributionConversationIds: [],
        backend,
      };
      const firstTracker = createGitHubPullRequestOutputTracker(
        "gh pr create --fill",
        options,
      );
      firstTracker?.append(
        "https://github.com/letta-ai/letta-code/pull/4006\n",
        "stdout",
      );
      const firstFinished = firstTracker
        ?.finish(controller.signal)
        .catch((error: unknown) => error);
      await started.promise;
      const reason = new Error("caller cancelled");
      controller.abort(reason);

      const nextTracker = createGitHubPullRequestOutputTracker(
        "gh pr create --fill",
        options,
      );
      nextTracker?.append(
        "https://github.com/letta-ai/letta-code/pull/4007\n",
        "stdout",
      );
      await nextTracker?.finish();
      expect(await firstFinished).toBe(reason);
      expect(tags).toEqual(["github:pull-request:letta-ai:letta-code:4007"]);

      // Successful late additions preserve the newer tag. Rejections remain
      // observed even after the caller has stopped waiting.
      if (lateResult === "success") stalled.resolve();
      else stalled.reject(new Error("late backend failure"));
      await Bun.sleep(0);
      expect(tags).toEqual([
        "github:pull-request:letta-ai:letta-code:4007",
        ...(lateResult === "success"
          ? ["github:pull-request:letta-ai:letta-code:4006"]
          : []),
      ]);
    },
  );

  test("attributes a default worker's new PR to every launching conversation", async () => {
    const backend = new MultiConversationTagBackend({
      "conv-root": [],
      "conv-parent": [
        "github:pull-request:letta-ai:letta-code:3000",
        "channel:slack",
      ],
    });
    const tracker = createGitHubPullRequestOutputTracker(
      "gh pr create --fill",
      {
        conversationId: "default",
        attributionConversationIds: ["conv-root", "conv-parent"],
        backend,
      },
    );

    tracker?.append(
      "https://github.com/letta-ai/letta-code/pull/4000\n",
      "stdout",
    );
    await tracker?.finish();

    expect(backend.tagsByConversation.get("conv-root")).toEqual([
      "github:pull-request:letta-ai:letta-code:4000",
    ]);
    expect(backend.tagsByConversation.get("conv-parent")).toEqual([
      "github:pull-request:letta-ai:letta-code:3000",
      "channel:slack",
      "github:pull-request:letta-ai:letta-code:4000",
    ]);
  });

  test("uses request-scoped listener attribution without leaking to the next turn", async () => {
    const backend = new MultiConversationTagBackend({
      "conv-launcher": [],
      "conv-worker": [],
    });
    const attributed = runWithRuntimeContext(
      {
        conversationId: "default",
        githubPullRequestConversationIds: ["conv-launcher"],
      },
      () =>
        createGitHubPullRequestOutputTracker("gh pr create --fill", {
          backend,
        }),
    );
    attributed?.append(
      "https://github.com/letta-ai/letta-code/pull/4002\n",
      "stdout",
    );
    await attributed?.finish();

    const unrelated = runWithRuntimeContext(
      { conversationId: "conv-worker" },
      () =>
        createGitHubPullRequestOutputTracker("gh pr create --fill", {
          backend,
        }),
    );
    unrelated?.append(
      "https://github.com/letta-ai/letta-code/pull/4003\n",
      "stdout",
    );
    await unrelated?.finish();

    expect(backend.tagsByConversation.get("conv-launcher")).toEqual([
      "github:pull-request:letta-ai:letta-code:4002",
    ]);
    expect(backend.tagsByConversation.get("conv-worker")).toEqual([
      "github:pull-request:letta-ai:letta-code:4003",
    ]);
  });

  test("deduplicates the active and launching conversation targets", async () => {
    const backend = new MultiConversationTagBackend({ "conv-parent": [] });
    const tracker = createGitHubPullRequestOutputTracker(
      "gh pr create --fill",
      {
        conversationId: "conv-parent",
        attributionConversationIds: ["conv-parent"],
        backend,
      },
    );

    tracker?.append(
      "https://github.com/letta-ai/letta-code/pull/4001\n",
      "stdout",
    );
    await tracker?.finish();

    expect(backend.tagsByConversation.get("conv-parent")).toEqual([
      "github:pull-request:letta-ai:letta-code:4001",
    ]);
  });

  test("skips default conversations without attribution and commands without PR creation", () => {
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
        attributionConversationIds: ["conv-parent"],
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
