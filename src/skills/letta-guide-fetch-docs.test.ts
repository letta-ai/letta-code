import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const skillDir = join(repoRoot, "src", "skills", "builtin", "letta-guide");
const fetchDocsScript = join(skillDir, "scripts", "fetch-letta-docs.mjs");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-guide-docs-"));
  tempDirs.push(dir);
  return dir;
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

async function runScript(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
  ]) {
    delete env[key];
  }
  const processHandle = Bun.spawn({
    cmd: ["node", fetchDocsScript, ...args],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

type DocsServerState = {
  body: string;
  etagOverride?: string;
  omitEtag?: boolean;
  weakEtag?: boolean;
};

async function withDocsServer<T>(
  state: DocsServerState,
  run: (url: string, requests: string[]) => Promise<T>,
): Promise<T> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.method ?? "");
    response.statusCode = 200;
    response.setHeader("content-type", "text/markdown; charset=utf-8");
    if (!state.omitEtag) {
      const weakPrefix = state.weakEtag ? "W/" : "";
      response.setHeader(
        "etag",
        `${weakPrefix}"${state.etagOverride ?? md5(state.body)}"`,
      );
    }
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(state.body);
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/llms.txt`);
    });
  });
  try {
    return await run(url, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function statusFromStderr(stderr: string): Record<string, unknown> {
  return JSON.parse(stderr.trim()) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("fetch-letta-docs", () => {
  test("fetches, verifies, caches, and outlines the current docs index", async () => {
    const cacheDir = makeTempDir();
    const body = `# Letta

## Configuration

- [Models](https://docs.letta.com/configuration/models/index.md)

### Providers

Details.

\`\`\`
## Hidden example
\`\`\`
`;

    await withDocsServer({ body, weakEtag: true }, async (url, requests) => {
      const first = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
        "--status-json",
      ]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(
        "Docs status: local document was updated.",
      );
      expect(first.stdout).toContain("Configuration (lines 3-");
      expect(first.stdout).toContain("Providers (lines 7-");
      expect(first.stdout).not.toContain("Hidden example");
      expect(requests).toEqual(["HEAD", "GET"]);

      const status = statusFromStderr(first.stderr);
      expect(status).toMatchObject({
        docsUrl: url,
        etagMd5: md5(body),
        fetchedMd5: md5(body),
        contentMatchesEtag: true,
        cacheStatus: "updated",
      });
      expect(readFileSync(status.docsPath as string, "utf8")).toBe(body);

      requests.length = 0;
      const second = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
        "--status-json",
      ]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain(
        "Docs status: local document was already current.",
      );
      expect(statusFromStderr(second.stderr)).toMatchObject({
        cacheStatus: "hit",
        fetchedMd5: md5(body),
      });
      expect(requests).toEqual(["HEAD"]);
    });
  }, 15_000);

  test("refetches when the remote ETag changes", async () => {
    const cacheDir = makeTempDir();
    const state = { body: "# Letta\n\n## Old\n" };
    await withDocsServer(state, async (url, requests) => {
      const first = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
        "--status-json",
      ]);
      expect(first.exitCode).toBe(0);

      state.body = "# Letta\n\n## New\n";
      requests.length = 0;
      const second = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
        "--status-json",
      ]);
      expect(second.exitCode).toBe(0);
      expect(statusFromStderr(second.stderr)).toMatchObject({
        etagMd5: md5(state.body),
        cacheStatus: "updated",
      });
      expect(requests).toEqual(["HEAD", "GET"]);
      expect(second.stdout).toContain("New (lines 3-3)");
    });
  });

  test("refetches when the local cache is corrupt", async () => {
    const cacheDir = makeTempDir();
    const body = "# Letta\n\n## Current\n";
    await withDocsServer({ body }, async (url, requests) => {
      const first = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
        "--status-json",
      ]);
      expect(first.exitCode).toBe(0);
      const status = statusFromStderr(first.stderr);
      writeFileSync(status.docsPath as string, "corrupt", "utf8");

      requests.length = 0;
      const second = await runScript([
        "--docs-url",
        url,
        "--cache-dir",
        cacheDir,
      ]);
      expect(second.exitCode).toBe(0);
      expect(requests).toEqual(["HEAD", "GET"]);
      expect(readFileSync(status.docsPath as string, "utf8")).toBe(body);
    });
  });

  test("rejects a body that does not match the response ETag", async () => {
    const cacheDir = makeTempDir();
    const body = "# Letta\n\n## Current\n";
    await withDocsServer(
      { body, etagOverride: "00000000000000000000000000000000" },
      async (url) => {
        const result = await runScript([
          "--docs-url",
          url,
          "--cache-dir",
          cacheDir,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("ETag did not match the fetched body");
      },
    );
  });

  test("rejects responses without a content-MD5 ETag", async () => {
    const cacheDir = makeTempDir();
    await withDocsServer(
      { body: "# Letta\n", omitEtag: true },
      async (url, requests) => {
        const result = await runScript([
          "--docs-url",
          url,
          "--cache-dir",
          cacheDir,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "Letta docs response is missing a content-MD5 ETag",
        );
        expect(requests).toEqual(["HEAD"]);
      },
    );
  });

  test("letta-guide uses direct verified retrieval before web fetch fallback", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("node <SKILL_DIR>/scripts/fetch-letta-docs.mjs");
    expect(skill).toContain('--docs-url "https://docs.letta.com/');
    expect(skill).toContain(
      "do not use `fetch_webpage`\n   for the normal docs route",
    );
    expect(skill).toContain(
      "use `fetch_webpage` only as a fallback with a\n   fresh query parameter",
    );
    expect(skill).not.toContain("~/.letta/docs-cache/");
  });
});
