import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

type CloneOptions = { operation?: string; timeoutMs?: number };
type GitRunner = (
  cwd: string,
  args: string[],
  token?: string,
  options?: CloneOptions,
) => Promise<{ stdout: string }>;

/** Optional object cache only: Git must still fetch authoritative origin refs. */
export function withPeerSeed(runGit: GitRunner) {
  return async function cloneWithPeerSeed(
    directory: string,
    args: string[],
    token: string,
    options: CloneOptions,
  ): Promise<void> {
    const sandboxId = process.env.DAYTONA_SANDBOX_ID;
    const remote = args.at(-2);
    // Callers supply a fresh staging directory, never a published checkout.
    if (!sandboxId || !remote || (await readdir(directory)).length !== 0) {
      return void (await runGit(directory, args, token, options));
    }
    let temporary: string | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let attemptedClone = false;
    try {
      const endpoint = new URL(`${remote}/seed`);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password
      ) {
        throw new Error("Invalid seed endpoint");
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Letta-Sandbox-Id": sandboxId,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status !== 200) throw new Error("Seed unavailable");
      const seed = (await response.json()) as {
        url?: unknown;
        shallow?: unknown;
      };
      if (typeof seed?.url !== "string") throw new Error("Seed unavailable");
      const shallow = seed.shallow ?? [];
      if (
        !Array.isArray(shallow) ||
        !shallow.every(
          (oid) => typeof oid === "string" && /^[a-f0-9]{40}$/.test(oid),
        )
      ) {
        throw new Error("Invalid shallow boundaries");
      }
      const url = new URL(seed.url);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Invalid seed URL");
      }
      // Never forward Letta credentials or follow redirects from a signed URL.
      const idle = new AbortController();
      const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 180_000),
        idle.signal,
      ]);
      // Bound time to first byte and stalls, while allowing progressing downloads.
      idleTimer = setTimeout(() => idle.abort(), 15_000);
      const download = await fetch(url, { redirect: "error", signal });
      if (!download.ok || !download.body) throw new Error("Seed unavailable");
      temporary = await mkdtemp(join(tmpdir(), "letta-git-seed-"));
      const bundle = join(temporary, "seed.bundle");
      await pipeline(
        Readable.fromWeb(download.body),
        new Transform({
          transform(chunk, _encoding, callback) {
            if (chunk.length) idleTimer?.refresh();
            callback(null, chunk);
          },
        }),
        createWriteStream(bundle, { mode: 0o600 }),
        { signal },
      );
      clearTimeout(idleTimer);
      idleTimer = undefined;
      // Accept standalone Git bundles, not bundle lists or response error pages.
      const file = await open(bundle, "r");
      try {
        const header = Buffer.alloc(16);
        await file.read(header, 0, header.length, 0);
        if (!/^# v[23] git bundle\n$/.test(header.toString())) {
          throw new Error("Invalid seed bundle");
        }
      } finally {
        await file.close();
      }
      attemptedClone = true;
      // --bundle-uri cannot preserve --depth. Import only cached remote refs,
      // then fetch the actual remote HEAD with the original depth semantics.
      const git = (command: string[]) =>
        runGit(directory, command, token, options);
      await git(["init"]);
      if (shallow.length) {
        await writeFile(
          join(directory, ".git", "shallow"),
          `${shallow.join("\n")}\n`,
        );
      }
      await git(["fetch", bundle, "+refs/remotes/origin/*:refs/seed/*"]);
      await git(["remote", "add", "origin", remote]);
      const { stdout } = await git(["ls-remote", "--symref", "origin", "HEAD"]);
      const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(stdout)?.[1];
      if (!branch) throw new Error("Remote has no branch HEAD");
      const isShallow = args.includes("--depth");
      if (isShallow)
        await git([
          "config",
          "remote.origin.fetch",
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]);
      const depth = isShallow
        ? ["--depth", "1"]
        : shallow.length
          ? ["--unshallow"]
          : [];
      await git(["fetch", ...depth, "origin"]);
      await git(["checkout", "-b", branch, "--track", `origin/${branch}`]);
      await git([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${branch}`,
      ]);
      const { stdout: refs } = await git([
        "for-each-ref",
        "--format=%(refname)",
        "refs/seed/",
      ]);
      for (const ref of refs.trim().split("\n").filter(Boolean)) {
        await git(["update-ref", "-d", ref]);
      }
      return;
    } catch {
      // All seed failures are cache misses. Do not log signed URLs or errors
      // from fetch, which can contain the signed URL. Older Git falls back too.
      if (attemptedClone) {
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true });
      }
    } finally {
      clearTimeout(idleTimer);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
    await runGit(directory, args, token, options);
  };
}
