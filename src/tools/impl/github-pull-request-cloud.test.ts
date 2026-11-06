import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import Letta from "@letta-ai/letta-client";
import { __testOverrideGetClient } from "@/backend/api/client";
import fixture from "./fixtures/github-cloud-snapshot.json";
import { createGitHubPullRequestSnapshotFetcher } from "./github-pull-request-cloud";
import { diffGitHubPullRequestSnapshots } from "./github-pull-request-diff";
import type { GitHubPullRequestSnapshot } from "./github-pull-request-types";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";
import { watch_pr } from "./watch-pr";

const fixtureEntry = fixture.snapshots[0];
if (!fixtureEntry) throw new Error("Missing snapshot fixture");
const ref = fixtureEntry.snapshot.ref;
const options = { cwd: process.cwd() };
const expected = {
  ...fixtureEntry.snapshot,
  readinessConfirmed: false,
} as GitHubPullRequestSnapshot;

function success() {
  return { status: 200, body: structuredClone(fixture) };
}

afterEach(() => __testOverrideGetClient(null));

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

  test("Cloud uses the contract request and preserves the complete diff shape", async () => {
    const fetchGh = mock(async () => expected);
    const request = mock(async () => success());
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request,
      fetchGh,
    });
    const snapshot = await fetchSnapshot(ref, options);
    const {
      merged: _merged,
      mergedBy: _mergedBy,
      ...clientShape
    } = expected as typeof expected & { merged: boolean; mergedBy: null };
    expect(snapshot).toEqual(clientShape);
    expect(request).toHaveBeenCalledWith(ref, undefined);
    expect(fetchGh).not.toHaveBeenCalled();
    const changed = { ...snapshot, comments: [] };
    expect(
      diffGitHubPullRequestSnapshots(changed, snapshot).events.join("\n"),
    ).toContain("Ready for review");
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

  for (const status of [404, 501]) {
    test(`${status} falls back once and caches unsupported for this watch only`, async () => {
      const request = mock(async () => ({ status, body: {} }));
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

  for (const status of [200, 429]) {
    test(`${status} cooldown waits until retry_at, discards stale data and reports once`, async () => {
      let time = Date.parse("2026-11-06T12:00:00Z");
      const retryAt = new Date(time + 90_000).toISOString();
      const stale = structuredClone(fixture);
      Object.assign(stale.snapshots[0] ?? {}, {
        stale: true,
        retry_at: retryAt,
      });
      const request = mock(async () => ({ status, body: stale }));
      const reportRateLimit = mock(() => {});
      const controller = new AbortController();
      const wait = mock(async (ms: number, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        expect(request).toHaveBeenCalledTimes(1);
        time += ms;
        request.mockImplementation(async () => success());
      });
      const fetchGh = mock(async () => expected);
      const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
        isCloud: () => true,
        request,
        wait,
        now: () => time,
        reportRateLimit,
        fetchGh,
      });
      const result = await fetchSnapshot(ref, {
        ...options,
        signal: controller.signal,
      });
      expect(wait).toHaveBeenCalledWith(90_000, controller.signal);
      expect(result.readinessConfirmed).toBe(false);
      expect(reportRateLimit).toHaveBeenCalledTimes(1);
      expect(fetchGh).not.toHaveBeenCalled();
      // Another cooldown in the same watch must not duplicate telemetry.
      wait.mockImplementation(async (ms) => {
        time += ms;
        request.mockImplementation(async () => success());
      });
      request.mockImplementationOnce(async () => ({ status, body: stale }));
      await fetchSnapshot(ref, options);
      expect(reportRateLimit).toHaveBeenCalledTimes(1);
    });
  }

  test("429 without a cached snapshot uses the response-level retry_at", async () => {
    const request = mock(
      async (): Promise<{ status: number; body: unknown }> => ({
        status: 429,
        body: {
          retry_at: "2026-11-06T12:01:00Z",
          snapshots: [
            { ...ref, snapshot: null, inaccessible: false, stale: false },
          ],
        },
      }),
    );
    const wait = mock(async () => {
      request.mockImplementation(async () => success());
    });
    await createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request,
      wait,
      now: () => Date.parse("2026-11-06T12:00:00Z"),
      reportRateLimit: () => {},
    })(ref, options);
    expect(wait).toHaveBeenCalledWith(60_000, undefined);
  });

  test("stopping the watch aborts a quota wait without another request", async () => {
    const controller = new AbortController();
    const request = mock(async () => ({ status: 429, body: {} }));
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request,
      reportRateLimit: () => {},
    });
    const pending = fetchSnapshot(ref, {
      ...options,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("permissions and server failures do not switch to gh", async () => {
    const fetchGh = mock(async () => expected);
    for (const result of [
      { status: 403, body: {} },
      { status: 502, body: {} },
      { status: 200, body: { snapshots: [{ ...ref, inaccessible: true }] } },
      { status: 200, body: { snapshots: [] } },
    ]) {
      await expect(
        createGitHubPullRequestSnapshotFetcher({
          isCloud: () => true,
          fetchGh,
          request: async () => result,
        })(ref, options),
      ).rejects.toThrow();
    }
    expect(fetchGh).not.toHaveBeenCalled();
  });

  test("a background watch stays running during cooldown without poll-error output", async () => {
    let requests = 0;
    let report!: () => void;
    const rateLimited = new Promise<void>((resolve) => {
      report = resolve;
    });
    const fetchSnapshot = createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      request: async () => {
        requests++;
        if (requests === 1) return success();
        return {
          status: 429,
          body: {
            snapshots: [],
            retry_at: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      reportRateLimit: report,
    });
    const result = await watch_pr(
      { url: ref.url },
      {
        fetchSnapshot,
        wait: async () => {},
      },
    );
    const state = backgroundProcesses.get(result.taskId);
    try {
      await rateLimited;
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

  test("SDK adapter sends authenticated contract request and handles real 429 errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let limited = true;
    const client = new Letta({
      apiKey: "test-key",
      baseURL: "https://api.letta.com",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json(
          limited ? { ...fixture, retry_at: "2026-11-06T12:01:00Z" } : fixture,
          { status: limited ? 429 : 200 },
        );
      },
    });
    __testOverrideGetClient(async () => client);
    const wait = mock(async () => {
      limited = false;
    });
    await createGitHubPullRequestSnapshotFetcher({
      isCloud: () => true,
      wait,
      now: () => Date.parse("2026-11-06T12:00:00Z"),
      reportRateLimit: () => {},
    })(ref, options);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://api.letta.com/v1/integrations/github/pull-request-snapshots",
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      prs: [{ owner: ref.owner, repo: ref.repo, number: ref.number }],
    });
    expect(wait).toHaveBeenCalledWith(60_000, undefined);
  });
});
