import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import Letta from "@letta-ai/letta-client";
import { __testOverrideGetClient } from "@/backend/api/client";
import { telemetry } from "@/telemetry";
import {
  type CloudSnapshotResponse,
  createGitHubPullRequestSnapshotFetcher,
} from "./github-pull-request-cloud";
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import type { GitHubPullRequestSnapshot } from "./github-pull-request-types";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";
import { watch_pr } from "./watch-pr";

const sha = "a".repeat(40);
const pullUrl = "https://github.com/letta-ai/letta-code/pull/42";
const ref = { owner: "letta-ai", repo: "letta-code", number: 42, url: pullUrl };
const key = { owner: ref.owner, repo: ref.repo, number: ref.number };
const comment = {
  id: "comment-1",
  author: "octocat",
  body: "Ready for review",
  url: `${pullUrl}#issuecomment-1`,
  updated_at: "2026-11-06T12:00:00Z",
};
const check = {
  key: "check:1",
  name: "test",
  phase: "success" as const,
  result: "SUCCESS",
  url: "https://github.com/letta-ai/letta-code/actions/runs/1",
};
const attempt = {
  key: "attempt:2",
  name: "test",
  phase: "failure" as const,
  result: "FAILURE",
};

function wireResponse(): CloudSnapshotResponse {
  return {
    snapshots: [
      {
        ...key,
        inaccessible: false,
        stale: false,
        snapshot: {
          ref,
          head_sha: sha,
          state: "OPEN",
          is_draft: false,
          merged: false,
          merged_by: null,
          mergeable: "MERGEABLE",
          merge_state_status: "CLEAN",
          review_decision: "APPROVED",
          readiness_confirmed: true,
          checks: [check],
          check_attempts: [attempt],
          comments: [comment],
          reviews: [
            {
              ...comment,
              id: "review-1",
              body: "Approved",
              url: `${pullUrl}#pullrequestreview-1`,
              state: "APPROVED",
              commit_sha: sha,
            },
          ],
          review_threads: [
            {
              id: "thread-1",
              is_resolved: true,
              comments: [
                {
                  ...comment,
                  id: "inline-1",
                  body: "Updated",
                  url: `${pullUrl}#discussion_r1`,
                  path: "src/index.ts",
                  line: 12,
                  outdated: false,
                  commit_sha: sha,
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

const clientComment = {
  id: comment.id,
  author: comment.author,
  body: comment.body,
  url: comment.url,
  updatedAt: comment.updated_at,
};
const expected: GitHubPullRequestSnapshot = {
  ref,
  headSha: sha,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  readinessConfirmed: false,
  checks: [check],
  checkAttempts: [attempt],
  comments: [clientComment],
  reviews: [
    {
      ...clientComment,
      id: "review-1",
      body: "Approved",
      url: `${pullUrl}#pullrequestreview-1`,
      state: "APPROVED",
      commitSha: sha,
    },
  ],
  reviewThreads: [
    {
      id: "thread-1",
      isResolved: true,
      comments: [
        {
          ...clientComment,
          id: "inline-1",
          body: "Updated",
          url: `${pullUrl}#discussion_r1`,
          path: "src/index.ts",
          line: 12,
          outdated: false,
          commitSha: sha,
        },
      ],
    },
  ],
};
const options = { cwd: process.cwd() };

function success() {
  return { status: 200 as const, body: wireResponse() };
}

function rateLimited(retryAt: string, stale: boolean) {
  const body = wireResponse();
  const [entry] = body.snapshots;
  if (!entry) throw new Error("Missing snapshot entry");
  if (stale) Object.assign(entry, { stale: true, retry_at: retryAt });
  else {
    Object.assign(entry, { snapshot: null });
    body.rate_limits = [{ ...key, retry_at: retryAt }];
  }
  return { status: 200 as const, body };
}

let trackError: ReturnType<typeof spyOn<typeof telemetry, "trackError">>;
beforeEach(() => {
  trackError = spyOn(telemetry, "trackError").mockImplementation(() => {});
});
afterEach(() => {
  trackError.mockRestore();
  __testOverrideGetClient(null);
});

describe("Cloud snapshot fetcher", () => {
  test("default selection follows the configured Cloud URL and excludes local backend", async () => {
    const previousUrl = process.env.LETTA_BASE_URL;
    const previousLocal = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    try {
      for (const [url, local, cloud] of [
        ["https://api.letta.com", "0", true],
        ["http://localhost:8283", "0", false],
        ["https://api.letta.com", "1", false],
      ] as const) {
        process.env.LETTA_BASE_URL = url;
        process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = local;
        const request = mock(async () => success());
        const fetchGh = mock(async () => expected);
        await createGitHubPullRequestSnapshotFetcher({ request, fetchGh })(
          ref,
          options,
        );
        expect(request).toHaveBeenCalledTimes(cloud ? 1 : 0);
        expect(fetchGh).toHaveBeenCalledTimes(cloud ? 0 : 1);
      }
    } finally {
      if (previousUrl === undefined) delete process.env.LETTA_BASE_URL;
      else process.env.LETTA_BASE_URL = previousUrl;
      if (previousLocal === undefined)
        delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
      else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = previousLocal;
    }
  });

  test("Cloud maps the snake_case contract into the client diff shape", async () => {
    const fetchGh = mock(async () => expected);
    const request = mock(async () => success());
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request,
      fetchGh,
    });
    const snapshot = await fetchSnapshot(ref, options);
    expect(snapshot).toEqual(expected);
    expect(request).toHaveBeenCalledWith(ref, undefined);
    expect(fetchGh).not.toHaveBeenCalled();
    const changed = { ...snapshot, comments: [] };
    expect(
      diffGitHubPullRequestSnapshots(changed, snapshot).events.join("\n"),
    ).toContain("Ready for review");
  });

  test("a merged PR maps to MERGED", async () => {
    const result = success();
    const entry = result.body.snapshots[0];
    if (entry?.snapshot) {
      entry.snapshot.merged = true;
      entry.snapshot.state = "CLOSED";
    }
    const snapshot = await createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request: async () => result,
    })(ref, options);
    expect(snapshot.state).toBe("MERGED");
  });

  test("local and self-hosted watches use gh without a Cloud request", async () => {
    const fetchGh = mock(async () => expected);
    const request = mock(async () => success());
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => false,
      request,
      fetchGh,
    });
    expect(await fetchSnapshot(ref, options)).toBe(expected);
    expect(fetchGh).toHaveBeenCalledWith(ref, options);
    expect(request).not.toHaveBeenCalled();
  });

  for (const status of [404, 501] as const) {
    test(`${status} falls back once and caches unsupported for this watch only`, async () => {
      const request = mock(async () => ({ status }));
      const fetchGh = mock(async () => expected);
      const deps = { isCloud: () => true, request, fetchGh };
      const fetchSnapshot = createGitHubPullRequestSnapshotFetcher(deps);
      await fetchSnapshot(ref, options);
      await fetchSnapshot(ref, options);
      expect(request).toHaveBeenCalledTimes(1);
      expect(fetchGh).toHaveBeenCalledTimes(2);
      await createGitHubPullRequestSnapshotFetcher(deps)(ref, options);
      expect(request).toHaveBeenCalledTimes(2);
    });
  }

  for (const stale of [true, false]) {
    test(`${stale ? "stale entry" : "rate_limits entry"} waits until retry_at and reports once`, async () => {
      let time = Date.parse("2026-11-06T12:00:00Z");
      const retryAt = new Date(time + 90_000).toISOString();
      const request = mock(
        async (): Promise<ReturnType<typeof success>> =>
          rateLimited(retryAt, stale),
      );
      const controller = new AbortController();
      const wait = mock(async (ms: number, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        time += ms;
        request.mockImplementation(async () => success());
      });
      const fetchGh = mock(async () => expected);
      const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
        isCloud: () => true,
        request,
        wait,
        now: () => time,
        fetchGh,
      });
      const result = await fetchSnapshot(ref, {
        ...options,
        signal: controller.signal,
      });
      expect(wait).toHaveBeenCalledWith(90_000, controller.signal);
      expect(request).toHaveBeenCalledTimes(2);
      expect(result).toEqual(expected);
      expect(trackError).toHaveBeenCalledTimes(1);
      expect(fetchGh).not.toHaveBeenCalled();
      // Another cooldown in the same watch must not duplicate telemetry.
      wait.mockImplementation(async (ms) => {
        time += ms;
        request.mockImplementation(async () => success());
      });
      request.mockImplementationOnce(async () => rateLimited(retryAt, stale));
      await fetchSnapshot(ref, options);
      expect(trackError).toHaveBeenCalledTimes(1);
    });
  }

  test("a 429 or expired retry_at waits the default cooldown instead of spinning", async () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    for (const first of [
      { status: 429 as const },
      rateLimited(new Date(now - 1_000).toISOString(), false),
    ]) {
      const request = mock(
        async (): Promise<{ status: 429 } | ReturnType<typeof success>> =>
          first,
      );
      const wait = mock(async () => {
        request.mockImplementation(async () => success());
      });
      await createGitHubPullRequestSnapshotFetcher({
        isCloud: () => true,
        request,
        wait,
        now: () => now,
      })(ref, options);
      expect(wait).toHaveBeenCalledWith(30_000, undefined);
    }
  });

  test("stopping the watch aborts a quota wait without another request", async () => {
    const controller = new AbortController();
    const request = mock(async () => ({ status: 429 as const }));
    const pending = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request,
    })(ref, { ...options, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("inaccessible, missing and server failures do not switch to gh", async () => {
    const fetchGh = mock(async () => expected);
    const inaccessible = success();
    Object.assign(inaccessible.body.snapshots[0] ?? {}, {
      inaccessible: true,
      snapshot: null,
    });
    const missing = { status: 200 as const, body: { snapshots: [] } };
    for (const result of [inaccessible, missing]) {
      await expect(
        createGitHubPullRequestSnapshotFetcher({
          isCloud: () => true,
          fetchGh,
          request: async () => result,
        })(ref, options),
      ).rejects.toThrow();
    }
    for (const status of [403, 502]) {
      const client = new Letta({
        apiKey: "test-key",
        baseURL: "https://api.letta.com",
        fetch: async () => Response.json({ message: "nope" }, { status }),
      });
      __testOverrideGetClient(async () => client);
      await expect(
        createGitHubPullRequestSnapshotFetcher({
          isCloud: () => true,
          fetchGh,
        })(ref, options),
      ).rejects.toThrow();
    }
    expect(fetchGh).not.toHaveBeenCalled();
  });

  test("a background watch stays running during cooldown without poll-error output", async () => {
    let requests = 0;
    let report!: () => void;
    const reported = new Promise<void>((resolve) => {
      report = resolve;
    });
    trackError.mockImplementation(() => report());
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request: async () => {
        requests++;
        if (requests === 1) return success();
        return rateLimited(new Date(Date.now() + 60_000).toISOString(), false);
      },
    });
    const result = await watch_pr(
      { url: ref.url },
      { fetchSnapshot, wait: async () => {} },
    );
    const state = backgroundProcesses.get(result.taskId);
    try {
      await reported;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(requests).toBe(2);
      expect(state?.status).toBe("running");
      expect(readFileSync(state?.outputFile ?? "", "utf8")).not.toContain(
        "[poll error",
      );
      await task_stop({ task_id: result.taskId });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(requests).toBe(2);
    } finally {
      if (state?.status === "running")
        await task_stop({ task_id: result.taskId });
      if (state?.outputFile) rmSync(state.outputFile, { force: true });
      backgroundProcesses.delete(result.taskId);
    }
  });

  test("SDK adapter sends the authenticated contract request and maps a real 404", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let missingRoute = false;
    const client = new Letta({
      apiKey: "test-key",
      baseURL: "https://api.letta.com",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return missingRoute
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json(wireResponse());
      },
    });
    __testOverrideGetClient(async () => client);
    const fetchGh = mock(async () => expected);
    expect(
      await createGitHubPullRequestSnapshotFetcher({
        isCloud: () => true,
        fetchGh,
      })(ref, options),
    ).toEqual(expected);
    expect(calls[0]?.url).toBe(
      "https://api.letta.com/v1/integrations/github/pull-request-snapshots",
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      pull_requests: [key],
    });
    missingRoute = true;
    await createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      fetchGh,
    })(ref, options);
    expect(fetchGh).toHaveBeenCalledTimes(1);
  });
});
